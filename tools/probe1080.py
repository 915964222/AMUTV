# -*- coding: utf-8 -*-
"""
批量核验 CMS V10 采集源的真实分辨率。
流程: 拉列表(最新1部) -> 拉详情 -> 取第一组播放地址首页 m3u8
     -> 读清单 RESOLUTION 高度 -> 下载首个 TS 分片解析 H.264 SPS 得真实宽高。
输出: tools/probe-results.json (追加模式,带时间戳)
用法: python tools/probe1080.py [名称=API ...]  (缺省用内置候选表)
"""
import base64, json, os, re, ssl, sys, time, urllib.request, urllib.parse

ctx = ssl.create_default_context()
ctx.check_hostname = False
ctx.verify_mode = ssl.CERT_NONE
# 采集源均为国内 CDN,本机代理会导致握手超时,强制直连
_opener = urllib.request.build_opener(urllib.request.ProxyHandler({}),
                                      urllib.request.HTTPSHandler(context=ctx))
urllib.request.install_opener(_opener)
UA = {'User-Agent': 'Mozilla/5.0 (Linux; Android 9) AppleWebKit/537.36'}

DEFAULT = {
    '非凡':   'https://api.ffzyapi.com/api.php/provide/vod/',
    '电影天堂': 'http://caiji.dyttzyapi.com/api.php/provide/vod/',
    '量子':   'https://cj.lziapi.com/api.php/provide/vod/',
    '旺旺':   'https://api.wwzy.tv/api.php/provide/vod/',
    '卧龙':   'https://collect.wolongzyw.com/api.php/provide/vod/',
    '暴风':   'https://bfzyapi.com/api.php/provide/vod/',
    '天涯':   'https://tyyszy.com/api.php/provide/vod/',
    '茅台':   'https://caiji.maotaizy.cc/api.php/provide/vod/',
    '闪电':   'https://sdzyapi.com/api.php/provide/vod/',
    '红牛':   'https://www.hongniuzy3.com/api.php/provide/vod/',
    '速播':   'https://www.suboziyuan.net/api.php/provide/vod/',
    '优质':   'https://api.zywzxc.com/api.php/provide/vod/',
}

def get(url, timeout=10, binary=False):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=timeout, context=ctx) as r:
        d = r.read()
    return d if binary else d.decode('utf-8', 'replace')

def get_m3u8_height(url, ref, timeout=10):
    """读 m3u8 文本中所有 RESOLUTION=WxH,返回最大高度(只看高度,宽度会骗人)"""
    try:
        txt = get(url, timeout, False)
    except Exception:
        return 0
    hs = [int(m.group(2)) for m in re.finditer(r'RESOLUTION=(\d+)x(\d+)', txt)]
    return max(hs) if hs else 0

# ---------- H.264 SPS 解析 ----------
class Bits:
    def __init__(self, d): self.d, self.p = d, 0
    def u(self, n):
        v = 0
        for _ in range(n):
            v = (v << 1) | ((self.d[self.p >> 3] >> (7 - (self.p & 7))) & 1)
            self.p += 1
        return v
    def ue(self):
        z = 0
        while self.u(1) == 0: z += 1
        return (1 << z) - 1 + (self.u(z) if z else 0)
    def se(self):
        k = self.ue()
        return (k + 1) // 2 if k % 2 else -(k // 2)

def unannexb(nal):
    """去掉 emulation prevention 0x000003"""
    return nal.replace(b'\x00\x00\x03', b'\x00\x00')

def _skip_list(b, size):
    last = 8
    for _ in range(size):
        delta = b.ue()
        nxt = (last + delta + 256) % 256
        if nxt: last = nxt

def parse_sps(nal):
    """按 ISO 14496-10 7.3.2.1 顺序完整解析,返回 (w,h) 或 None"""
    b = Bits(unannexb(nal))
    try:
        prof = b.u(8)
        b.u(8); b.u(8)                          # constraint/level
        b.ue()                                  # sps_id
        if prof in (100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135):
            cf = b.ue()
            if cf == 3: b.u(1)                  # separate_colour_plane
            b.ue()                              # bit_depth_luma_minus8
            b.ue()                              # bit_depth_chroma_minus8
            b.u(1)                              # qpprime_y
            if b.u(1):                          # seq_scaling_matrix_present
                for i in range(12 if cf == 3 else 8):
                    if b.u(1):
                        _skip_list(b, 16 if i < 6 else 64)
        b.ue()                                  # log2_max_frame_num_minus4
        poc = b.ue()
        if poc == 0:
            b.ue()
        elif poc == 1:
            b.u(1); b.se(); b.se()
            n = b.ue()
            for _ in range(n): b.se()
        b.ue()                                  # max_num_ref_frames
        b.u(1)                                  # gaps_in_frame_num
        w_mbs = b.ue() + 1
        h_map = b.ue() + 1
        fmb = b.u(1)                            # frame_mbs_only
        if not fmb: b.u(1)                      # mb_adaptive_frame_field
        b.u(1)                                  # direct_8x8_inference
        crop = b.u(1)
        cw = ch = 0
        if crop:
            cw = (b.ue() + b.ue()) * 2
            ch = (b.ue() + b.ue()) * 2
        w = w_mbs * 16 - cw
        h = h_map * 16 * (2 - fmb) - ch
        return (w, h)
    except Exception:
        return None

def real_res(m3u8_url, ref, segs=6):
    """下载前 segs 个分片,解析 SPS 求真实宽高(首个可能非关键帧)"""
    try:
        txt = get(m3u8_url, 10)
    except Exception:
        return None
    base = m3u8_url.rsplit('/', 1)[0] + '/'
    ts = [l for l in txt.splitlines() if l and not l.startswith('#')]
    if ts and not ts[0].startswith('http'):
        ts = [base + t for t in ts]
    for u in ts[:segs]:
        try:
            d = get(u, 12, True)
        except Exception:
            continue
        # 剥 TS:188 字节包,PES 里找 NAL type 7 (00 00 01 67 / 00 00 00 01 67)
        for m in re.finditer(b'\x00\x00\x00?\x01\x67', d):
            start = m.end()
            nxt = re.search(b'\x00\x00\x00?\x01', d[start:start + 200000])
            nal = d[start:start + (nxt.start() if nxt else 300)]
            r = parse_sps(nal)
            if r and r[0] > 100:
                return r
    return None

def resolve_share(url, timeout=10):
    """分享页 → 直链 m3u8(提取 var main = "..."),已是 m3u8 则原样返回"""
    if '.m3u8' in url:
        return url
    try:
        html = get(url, timeout)
    except Exception:
        return None
    m = re.search(r'var\s+main\s*=\s*["\']([^"\']+)', html)
    if not m:
        m = re.search(r'["\']([^"\']*\.m3u8[^"\']*)["\']', html)
        if not m:
            return None
    u = m.group(1)
    if u.startswith('/'):
        p = urllib.parse.urlparse(url)
        u = f'{p.scheme}://{p.netloc}{u}'
    return u

def probe(name, api):
    t0 = time.time()
    out = {'name': name, 'api': api}
    try:
        lst = json.loads(get(api + '?ac=list&pg=1', 10))['list']
        best = {'ok': False}
        for item in lst[:6]:                    # 每源试 6 部,取最优
            r = probe_one(item['vod_id'], api, item)
            r['vod'] = item.get('vod_name', '?')
            if r.get('real_h', 0) > best.get('real_h', 0):
                best = r
            if r.get('ok'):
                break
        best['ms'] = int((time.time() - t0) * 1000)
        best['name'], best['api'] = name, api
        return best
    except Exception as e:
        return {'name': name, 'api': api, 'ok': False, 'err': str(e)[:120]}

def probe_one(vid, api, item):
    out = {}
    try:
        det = json.loads(get(api + f'?ac=detail&ids={vid}', 10))['list'][0]
        play = det.get('vod_play_url', '')
        first_group = play.split('$$$')[0]
        ep1 = first_group.split('#')[0].split('$')[-1]
        direct = resolve_share(ep1)
        if not direct or '.m3u8' not in direct:
            out['ok'] = False; out['err'] = '无法解析直链: ' + ep1[:60]; return out
        h = get_m3u8_height(direct, direct)
        out['m3u8'] = direct
        out['declared_h'] = h
        if h and h < 700:                       # 清单高度太低,不值得做 SPS 实测
            out['real'] = None; out['real_h'] = h; out['ok'] = False
            return out
        rr = real_res(direct, direct)
        out['real'] = f'{rr[0]}x{rr[1]}' if rr else None
        out['real_h'] = rr[1] if rr else 0
        out['ok'] = bool(rr and rr[1] >= 1000)
    except Exception as e:
        out['ok'] = False; out['err'] = str(e)[:120]
    return out

def main():
    srcs = dict(DEFAULT)
    for a in sys.argv[1:]:
        k, _, v = a.partition('=')
        srcs[k] = v
    results = []
    for name, api in srcs.items():
        r = probe(name, api)
        results.append(r)
        flag = 'OK ' if r.get('ok') else '-- '
        print(f"[{flag}] {name:6s} {r.get('vod','-')[:12]:12s} "
              f"声明{str(r.get('declared_h','-')):>5} 实测{str(r.get('real') or '--'):>10} "
              f"({r.get('ms','-')}ms) {r.get('err','')}", flush=True)
    with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'probe-results.json'), 'w', encoding='utf-8') as f:
        json.dump({'ts': time.strftime('%Y-%m-%d %H:%M:%S'), 'results': results}, f, ensure_ascii=False, indent=1)
    good = [r['name'] for r in results if r.get('ok')]
    print('\n真1080P源:', ', '.join(good) if good else '(无)')

if __name__ == '__main__':
    main()
