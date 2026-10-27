# -*- coding: utf-8 -*-
"""按片名定向核验:同一部片子在各源上的真实分辨率(可比性强)。
用法: python tools/probe-title.py "流浪地球2" [额外源:名称=API ...]
"""
import importlib.util, json, os, sys, time

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location('p', os.path.join(HERE, 'probe1080.py'))
P = importlib.util.module_from_spec(spec); spec.loader.exec_module(P)

def probe_title(name, api, title):
    t0 = time.time()
    out = {'name': name, 'api': api, 'title': title}
    try:
        j = json.loads(P.get(api + '?ac=detail&wd=' + P.urllib.parse.quote(title), 12))
        lst = j.get('list') or []
        if not lst:
            out['err'] = '无搜索结果'; return out
        best = {'ok': False, 'real_h': 0}
        for it in lst[:2]:
            play = it.get('vod_play_url', '')
            if not play:
                continue
            ep1 = play.split('$$$')[0].split('#')[0].split('$')[-1]
            direct = P.resolve_share(ep1)
            if not direct or '.m3u8' not in direct:
                continue
            h = P.get_m3u8_height(direct, direct)
            rr = P.real_res(direct, direct) if (not h or h >= 700) else None
            r = {'ok': bool(rr and rr[1] >= 1000), 'declared_h': h,
                 'real': f'{rr[0]}x{rr[1]}' if rr else None, 'real_h': rr[1] if rr else 0,
                 'vod': it.get('vod_name', ''), 'm3u8': direct}
            if r['real_h'] > best['real_h']:
                best = r
            if r['ok']:
                break
        best['ms'] = int((time.time() - t0) * 1000)
        best['name'], best['api'] = name, api
        return best
    except Exception as e:
        out['err'] = str(e)[:120]
        return out

def main():
    title = sys.argv[1] if len(sys.argv) > 1 else '流浪地球2'
    srcs = dict(P.DEFAULT)
    for a in sys.argv[2:]:
        k, _, v = a.partition('=')
        srcs[k] = v
    res = []
    for n, a in srcs.items():
        r = probe_title(n, a, title)
        res.append(r)
        print(f"[{'OK ' if r.get('ok') else '-- '}] {n:6s} {str(r.get('vod','-'))[:14]:14s} "
              f"声明{str(r.get('declared_h','-')):>5} 实测{str(r.get('real') or '--'):>10} "
              f"({r.get('ms','-')}ms) {r.get('err','')}", flush=True)
    with open(os.path.join(HERE, 'probe-title.json'), 'w', encoding='utf-8') as f:
        json.dump({'ts': time.strftime('%Y-%m-%d %H:%M:%S'), 'title': title, 'results': res},
                  f, ensure_ascii=False, indent=1)
    good = [r['name'] for r in res if r.get('ok')]
    print('\n真1080P源:', ', '.join(good) if good else '(无)')

if __name__ == '__main__':
    main()
