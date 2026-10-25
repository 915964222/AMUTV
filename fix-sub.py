# -*- coding: utf-8 -*-
import io

p = r'C:\Users\91596\.zcode\workspace\17e4ecba-c7c4-40ce-b117-87a9e9f578b3\tvbox-web\js\player.js'
s = io.open(p, encoding='utf-8').read()

# 1) 外挂字幕:加载/挂载/抽屉区(插在 ensureDanmaku 前)
old1 = """    /* ---------- 弹幕状态与控件 ---------- */"""
new1 = """    /* ---------- 外挂字幕:抓取文本 → addTextTrack ---------- */
    let subsLoading = false;
    function setupSubtitles() {
      if (!state.subs || !state.subs.length || subsLoading) return;
      subsLoading = true;
      let done = 0;
      state.subs.forEach(function (s) {
        fetch(s.url).then(function (r) { return r.arrayBuffer(); })
          .then(function (buf) {
            const text = window.Subtitles.decodeSmart(buf);
            const cues = window.Subtitles.parse(text, s.name);
            if (!cues.length) return;
            let track = null;
            for (let i = 0; i < video.textTracks.length; i++) {
              if (video.textTracks[i].label === s.name) { track = video.textTracks[i]; break; }
            }
            if (!track) {
              track = video.addTextTrack('subtitles', s.name, 'zh');
              cues.forEach(function (c) {
                try { track.addCue(new VTTCue(c.start, c.end, c.text)); } catch (e) {}
              });
            }
            track.mode = (done === 0) ? 'showing' : 'hidden';   // 第一条默认显示
            if (window.toast && done === 0) toast('外挂字幕已加载:' + s.name);
            done++;
          })
          .catch(function () {});
      });
      subsLoading = false;
    }
    function subTrackList() {
      const list = [];
      try {
        for (let i = 0; i < video.textTracks.length; i++) {
          const t = video.textTracks[i];
          if (t.kind === 'subtitles') list.push({ track: t, name: t.label || ('字幕' + (i + 1)), showing: t.mode === 'showing' });
        }
      } catch (e) {}
      return list;
    }

    /* ---------- 弹幕状态与控件 ---------- */"""
assert old1 in s, 'danmaku anchor missing'
s = s.replace(old1, new1, 1)

# 2) loadEpisode 元数据就绪后挂字幕
s = s.replace("""      video.play().catch(() => showCenter(`<button class="bigplay" data-act="play">▶</button>`));
      showCenter('');""",
"""      setupSubtitles();
      video.play().catch(() => showCenter(`<button class="bigplay" data-act="play">▶</button>`));
      showCenter('');""")

# 3) pset 抽屉:字幕区(外挂轨列表 + 手动加载)
old3 = """      /* 弹幕 */
      ensureDanmaku();"""
new3 = """      /* 字幕 */
      const subList = subTrackList();
      if (subList.length || (state.subs && state.subs.length)) {
        body.appendChild(el('<div class="d-group">字幕</div>'));
        const sg = el('<div class="ep-grid"></div>');
        const offB = el('<button class="ep' + subList.every(function (t) { return t.showing === false; }) || subList.length === 0 ? '' : '') + '" data-f tabindex="-1">关闭</button>');
        offB.className = 'ep';
        offB.onclick = function () { subList.forEach(function (t) { t.track.mode = 'hidden'; }); render(body); };
        sg.appendChild(offB);
        subList.forEach(function (t, i) {
          const b = el('<button class="ep' + (t.track.mode === 'showing' ? ' current' : '') + '" data-f tabindex="-1">' + t.name + '</button>');
          b.onclick = function () {
            subList2 = subTrackList();
            subList2.forEach(function (x, xi) { x.track.mode = (xi === i ? 'showing' : 'hidden'); });
            render(body);
          };
          sg.appendChild(b);
        });
        const loadB = el('<button class="ep" data-f tabindex="-1">📂 加载字幕文件</button>');
        loadB.onclick = function () {
          const inp = el('<input type="file" accept=".srt,.vtt,.ass,.ssa,text/plain" style="display:none">');
          inp.onchange = function () {
            const f = inp.files[0];
            if (!f) return;
            f.arrayBuffer().then(function (buf) {
              const text = window.Subtitles.decodeSmart(buf);
              const cues = window.Subtitles.parse(text, f.name);
              if (!cues.length) { if (window.toast) toast('字幕解析失败(格式不支持)'); return; }
              let track = null;
              for (let i = 0; i < video.textTracks.length; i++) {
                if (video.textTracks[i].label === f.name) { track = video.textTracks[i]; break; }
              }
              if (!track) {
                track = video.addTextTrack('subtitles', f.name, 'zh');
                cues.forEach(function (c) { try { track.addCue(new VTTCue(c.start, c.end, c.text)); } catch (e) {} });
              }
              track.mode = 'showing';
              if (window.toast) toast('字幕已加载:' + f.name);
              render(body);
            });
          };
          inp.click();
        };
        sg.appendChild(loadB);
        body.appendChild(sg);
        body.appendChild(el('<div class="hint">音轨切换:HLS 流的多音轨支持;纯 MP4 的内封多音轨浏览器暂不支持切换。</div>'));
      }

      /* 弹幕 */
      ensureDanmaku();"""
assert old3 in s, 'speed anchor missing'
s = s.replace(old3, new3, 1)

# 4) exit 清字幕状态
s = s.replace("""    if (dm) { try { dm.destroy(); } catch (_e) {} dm = null; }""",
"""    if (dm) { try { dm.destroy(); } catch (_e) {} dm = null; }
    subsLoading = false;""")

io.open(p, 'w', encoding='utf-8').write(s)
print('subtitles integrated')
