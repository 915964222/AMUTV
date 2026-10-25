/* ============ 悬浮弹幕引擎:B站格式 XML 解析 + 渲染 ============
 * 支持文件:B站弹幕 XML(<d p="time,mode,size,color,[...]">文字</d>)与弹弹play XML
 * 渲染:右→左滚动 / 底部固定,随视频时间同步,支持开关/透明度/字号/速度/显示区域
 */
(function () {
  const state = {
    items: [],        // {t, mode, size, color, text}
    on: true,
    opacity: 0.85,
    fontScale: 1,
    speed: 1,         // 滚动速度倍率
    area: 1,          // 显示区域 0.5=半屏 1=全屏
  };

  /* 解析 XML(B站/弹弹play 通用格式) */
  function parseXML(xmlText) {
    const doc = new DOMParser().parseFromString(xmlText, 'text/xml');
    const out = [];
    doc.querySelectorAll('d').forEach(d => {
      const p = (d.getAttribute('p') || '').split(',');
      const t = parseFloat(p[0]);
      if (isNaN(t)) return;
      out.push({
        t: t,
        mode: Number(p[1]) || 1,          // 1-3滚动 4底 5顶
        size: Number(p[2]) || 25,
        color: '#' + (Number(p[3]) || 16777215).toString(16).padStart(6, '0'),
        text: (d.textContent || '').trim(),
      });
    });
    out.sort((a, b) => a.t - b.t);
    return out;
  }

  /* 渲染器:挂在容器(播放器)上,跟随 video 元素时间 */
  function createRenderer(container, getVideo) {
    const layer = document.createElement('div');
    layer.className = 'dm-layer';
    container.appendChild(layer);
    const st = Object.assign({}, state);
    let items = [];
    let ptr = 0;                 // 下一条待发送索引
    let raf = null;
    let lastSeek = -1;
    const live = [];             // 屏幕上滚动中的弹幕 {el, start, dur}

    function setItems(list) { items = list.sort((a, b) => a.t - b.t); reset(); }
    function reset() {
      live.forEach(l => l.el.remove());
      live.length = 0;
      ptr = 0;
      lastSeek = -1;
    }
    function setOn(v) { st.on = v; layer.style.display = v ? '' : 'none'; if (!v) reset(); }
    function setOpacity(v) { st.opacity = v; layer.style.opacity = v; }
    function setFontScale(v) { st.fontScale = v; }
    function setSpeed(v) { st.speed = (typeof v === 'number' && v > 0) ? v : 1; }
    function setArea(v) { st.area = v; }

    function spawn(it) {
      const el = document.createElement('div');
      el.className = 'dm-item' + (it.mode === 4 || it.mode === 5 ? ' dm-fixed' : '');
      el.textContent = it.text;
      el.style.fontSize = Math.round(it.size * st.fontScale) + 'px';
      el.style.color = it.color;
      if (it.mode === 4 || it.mode === 5) { el.classList.add(it.mode === 5 ? 'dm-top' : 'dm-bottom'); }
      else { el.style.top = Math.round(Math.random() * (layer.clientHeight * st.area - 40)) + 'px'; }
      layer.appendChild(el);
      const w = el.offsetWidth || 200;
      const dur = Math.max(6, Math.min(14, layer.clientWidth / 120)) / st.speed;
      el.style.transition = 'transform ' + dur + 's linear';
      el.style.transform = 'translateX(' + layer.clientWidth + 'px)';
      requestAnimationFrame(() => { el.style.transform = 'translateX(-' + w + 'px)'; });
      const rec = { el: el, start: performance.now(), dur: dur * 1000, mode: it.mode };
      live.push(rec);
      setTimeout(() => { el.remove(); const i = live.indexOf(rec); if (i > -1) live.splice(i, 1); }, dur * 1000 + 100);
    }

    function tick() {
      if (st.on && items.length) {
        const v = getVideo();
        if (v && !v.paused) {
          const t = v.currentTime;
          // 用户 seek(跳变>1.5s,含回退)→ 重置指针重新定位
          if (lastSeek >= 0 && Math.abs(t - lastSeek) > 1.5) reset();
          lastSeek = t;
          while (ptr < items.length && items[ptr].t <= t) {
            const it = items[ptr++];
            const remain = Math.max(0.1, (layer.clientWidth + 200) / 120 / st.speed);
            if (t - it.t < remain) spawn(it);   // 只发时间上还跟得上的
          }
          // 清理滚出屏幕的
          const now = performance.now();
          for (let i = live.length - 1; i >= 0; i--) {
            const l = live[i];
            if (now - l.start > l.dur * 1000 + 200) { l.el.remove(); live.splice(i, 1); }
          }
        }
      }
      raf = requestAnimationFrame(tick);
    }
    raf = requestAnimationFrame(tick);

    return {
      setItems, setOn, setOpacity, setFontScale, setSpeed, setArea, reset,
      destroy: function () { cancelAnimationFrame(raf); live.forEach(l => l.el.remove()); layer.remove(); },
      layer: layer,
      get state() { return st; },   /* 播放器UI读取 on/opacity 等当前值 */
    };
  }

  /* 在线弹幕:POST /dm/fetch(自定义模板或弹弹play官方凭证) → B站XML 解析 */
  async function fetchOnline(fileName) {
    const cfg = (typeof DB !== 'undefined' && DB.getConfig()) || {};
    const SRV = location.protocol === 'file:' ? 'http://127.0.0.1:9978' : '';
    const r = await fetch(SRV + '/dm/fetch', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileName: fileName, tpl: cfg.dmTpl || '', appId: cfg.dmAppId || '', appSecret: cfg.dmAppSecret || '' }),
    }).then(x => x.json());
    if (r.error) throw new Error(r.error);
    return { items: parseXML(r.xml), matched: r.matched || '' };
  }

  window.Danmaku = { parseXML: parseXML, createRenderer: createRenderer, fetchOnline: fetchOnline, state: state };
})();
