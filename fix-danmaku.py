# -*- coding: utf-8 -*-
import io

p = r'C:\Users\91596\.zcode\workspace\17e4ecba-c7c4-40ce-b117-87a9e9f578b3\tvbox-web\js\player.js'
s = io.open(p, encoding='utf-8').read()

# 1) 抽屉顶部加 弹幕 区块(加载文件/开关/字号/透明度)
old = """    function render(body) {
      body.innerHTML = '';
      /* 快捷操作:换源 / 嗅探 / 上集(低频功能收纳进二级抽屉) */"""
new = """    /* ---------- 弹幕状态与控件 ---------- */
    let dm = null; // 弹幕渲染器实例
    function ensureDanmaku() {
      if (dm || !window.Danmaku) return;
      const saved = JSON.parse(localStorage.getItem('tvw_danmaku') || '{"on":true,"opacity":0.85,"fontScale":1,"speed":1,"text":""}');
      dm = window.Danmaku.createRenderer(root, () => video);
      dm.setOpacity(saved.opacity); dm.setFontScale(saved.fontScale); dm.setSpeed(saved.speed);
      dm.setOn(saved.on && !!saved.text);
      if (saved.text) { try { dm.setItems(window.Danmaku.parseXML(saved.text)); } catch (e) {} }
    }
    function saveDm() {
      if (!dm) return;
      localStorage.setItem('tvw_danmaku', JSON.stringify({
        on: dm.state.on, opacity: dm.state.opacity, fontScale: dm.state.fontScale, speed: dm.state.speed,
        text: (localStorage.getItem('tvw_danmaku') && JSON.parse(localStorage.getItem('tvw_danmaku')).text) || '',
      }));
    }

    function render(body) {
      body.innerHTML = '';
      /* 快捷操作:换源 / 嗅探 / 上集(低频功能收纳进二级抽屉) */"""
assert old in s, 'pset render anchor missing'
s = s.replace(old, new)

# 2) render 内加入弹幕区(插在 倍速 区块前)
old2 = """      body.appendChild(el('<div class="d-group">倍速</div>'));"""
new2 = """      /* 弹幕 */
      ensureDanmaku();
      if (window.Danmaku) {
        body.appendChild(el('<div class="d-group">弹幕</div>'));
        const dg = el('<div class="ep-grid"></div>');
        const savedDm = JSON.parse(localStorage.getItem('tvw_danmaku') || '{"on":true,"opacity":0.85,"fontScale":1}');
        const onB = el('<button class="ep' + (dm.state.on ? ' current' : '') + '" data-f tabindex="-1">' + (dm.state.on ? '弹幕 开' : '弹幕 关') + '</button>');
        onB.onclick = function () { dm.setOn(!dm.state.on); saveDm(); render(body); };
        dg.appendChild(onB);
        [[0.5, '淡'], [0.85, '标准'], [1, '浓']].forEach(function (pair) {
          const cur = Math.abs(dm.state.opacity - pair[0]) < 0.05;
          const b = el('<button class="ep' + (cur ? ' current' : '') + '" data-f tabindex="-1">透明 ' + pair[1] + '</button>');
          b.onclick = function () { dm.setOpacity(pair[0]); saveDm(); render(body); };
          dg.appendChild(b);
        });
        [[0.8, '小'], [1, '中'], [1.3, '大']].forEach(function (pair) {
          const cur = Math.abs(dm.state.fontScale - pair[0]) < 0.05;
          const b = el('<button class="ep' + (cur ? ' current' : '') + '" data-f tabindex="-1">' + pair[1] + '字</button>');
          b.onclick = function () { dm.setFontScale(pair[0]); saveDm(); render(body); };
          dg.appendChild(b);
        });
        const fileB = el('<button class="ep" data-f tabindex="-1">📂 加载弹幕文件(XML)</button>');
        fileB.onclick = function () {
          const inp = el('<input type="file" accept=".xml,text/xml" style="display:none">');
          inp.onchange = function () {
            const f = inp.files[0];
            if (!f) return;
            const r = new FileReader();
            r.onload = function () {
              try {
                dm.setItems(window.Danmaku.parseXML(r.result));
                const sv = JSON.parse(localStorage.getItem('tvw_danmaku') || '{}');
                sv.text = r.result; sv.on = true;
                localStorage.setItem('tvw_danmaku', JSON.stringify(sv));
                dm.setOn(true);
                if (window.toast) toast('弹幕已加载:' + f.name);
                render(body);
              } catch (e) { if (window.toast) toast('弹幕解析失败:' + e.message); }
            };
            r.readAsText(f, 'utf-8');
          };
          inp.click();
        };
        dg.appendChild(fileB);
        body.appendChild(dg);
        body.appendChild(el('<div class="hint">弹幕文件:B站格式 XML(弹弹play 兼容),加载后本片自动记忆</div>'));
      }

      body.appendChild(el('<div class="d-group">倍速</div>'));"""
assert old2 in s, 'speed anchor missing'
s = s.replace(old2, new2)

# 3) destroy 清弹幕
s = s.replace("""  function exit() {
    saveProgress();
    destroyEngine();""",
"""  function exit() {
    saveProgress();
    destroyEngine();
    if (dm) { try { dm.destroy(); } catch (_e) {} dm = null; }""")

io.open(p, 'w', encoding='utf-8').write(s)
print('danmaku integrated into player')
