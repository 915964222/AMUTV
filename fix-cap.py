# -*- coding: utf-8 -*-
import io

p = r'C:\Users\91596\.zcode\workspace\17e4ecba-c7c4-40ce-b117-87a9e9f578b3\tvbox-web\js\app.js'
s = io.open(p, encoding='utf-8').read()

# 1) 设置页:设备能力检测 section(插在 关于 前)
old = '''        <div class="section">
          <h3>关于</h3>'''
new = '''        <div class="section">
          <h3>设备解码能力(如实检测)</h3>
          <div class="cap-grid" id="cap-grid">检测中…</div>
          <div class="hint">以上为浏览器/WebView 实际支持的解码能力(绿=流畅硬解,白=可解,灰=不支持)。
          杜比视界/HDR10+ 的 HDR 显示效果还需屏幕支持;音频源码透传(TrueHD/Atmos/DTS-HD)浏览器架构不支持,需 MPV 等原生播放器。</div>
        </div>
        <div class="section">
          <h3>关于</h3>'''
assert old in s, 'about anchor missing'
s = s.replace(old, new, 1)

# 2) 检测触发(插在 cfg-scrape 绑定后)
old2 = """    view().querySelector('#cfg-scrape').onchange = e => { DB.setConfig({ scrapeOn: e.target.checked }); toast(e.target.checked ? '已开启刮削' : '已关闭刮削'); };"""
new2 = old2 + """

    // 设备解码能力检测(MediaCapabilities API,如实报告)
    runCapTest().then(function (html) { const g = view.querySelector('#cap-grid'); if (g) g.innerHTML = html; });"""
assert old2 in s, 'cfg-scrape anchor missing'
s = s.replace(old2, new2, 1)

# 3) runCapTest 函数(插在 直播页 前)
old3 = "  /* ============ 直播(IPTV)页 ============ */"
new3 = """  /* 设备解码能力检测:4K/8K/HEVC/AV1/杜比视界/HDR10(绿=流畅硬解,白=可解,灰=不支持) */
  async function runCapTest() {
    const mc = navigator.mediaCapabilities;
    const test = async function (label, contentType, w, h, bitrate) {
      if (!mc || !mc.decodingInfo) return '<span class="cap-no">' + label + ':不支持检测</span>';
      try {
        const cfg = { type: 'file', video: { contentType: contentType, width: w, height: h, bitrate: bitrate, framerate: 30 } };
        const r = (await mc.decodingInfo([cfg]))[0];
        if (r.smooth) return '<span class="cap-ok">✔ ' + label + '(流畅硬解)</span>';
        if (r.supported) return '<span style="color:#e5e5ea">○ ' + label + '(可解,可能卡)</span>';
        return '<span class="cap-no">✘ ' + label + ':不支持</span>';
      } catch (e) { return '<span class="cap-no">✘ ' + label + ':检测失败</span>'; }
    };
    const rows = [];
    rows.push(await test('4K H.264', 'video/mp4; codecs="avc1.640033"', 3840, 2160, 25000000));
    rows.push(await test('4K HEVC/H.265', 'video/mp4; codecs="hvc1.1.6.L153.B0"', 3840, 2160, 30000000));
    rows.push(await test('4K VP9', 'video/webm; codecs="vp09.00.51.08"', 3840, 2160, 30000000));
    rows.push(await test('4K AV1', 'video/mp4; codecs="av01.0.13M.08"', 3840, 2160, 30000000));
    rows.push(await test('8K H.264', 'video/mp4; codecs="avc1.640034"', 7680, 4320, 60000000));
    const msOk = function (t) { try { return window.MediaSource && MediaSource.isTypeSupported(t); } catch (e) { return false; } };
    rows.push(msOk('video/mp4; codecs="dvh1.05.07"') ? '<span class="cap-ok">✔ 杜比视界(MSE)</span>' : '<span class="cap-no">✘ 杜比视界:不支持</span>');
    rows.push(msOk('video/mp4; codecs="hvc1.2.4.L153.B0"') ? '<span class="cap-ok">✔ HEVC HDR10(容器)</span>' : '<span class="cap-no">✘ HDR10(MSE):不支持</span>');
    return rows.join('<br>');
  }

  /* ============ 直播(IPTV)页 ============ */"""
assert old3 in s, 'live anchor missing'
s = s.replace(old3, new3, 1)

io.open(p, 'w', encoding='utf-8').write(s)
print('cap test added')
