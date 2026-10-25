/* ================= 遥控器式方向键焦点导航 =================
 * ↑↓←→ 在可聚焦元素间按屏幕几何位置移动;
 * Enter/点击 确认;Backspace/Esc 返回。
 * ================================================= */
const KeyNav = (() => {
  const SELECTOR = '[data-f]';
  let modalLayer = 0; // 弹窗打开时,导航限制在弹窗内
  let playerMode = false; // 播放器有自己的按键逻辑

  function focusables() {
    const root = modalLayer > 0
      ? document.querySelector('.modal-mask, .pl-drawer') || document
      : document;
    return [...root.querySelectorAll(SELECTOR)].filter(el =>
      el.offsetParent !== null || el === document.activeElement);
  }

  function center(el) {
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, r };
  }

  function pick(current, dir) {
    const c = center(current);
    let best = null, bestScore = Infinity;
    for (const el of focusables()) {
      if (el === current) continue;
      const p = center(el);
      const dx = p.x - c.x, dy = p.y - c.y;
      let primary = 0, cross = 0;
      if (dir === 'left') { primary = -dx; cross = Math.abs(dy); }
      else if (dir === 'right') { primary = dx; cross = Math.abs(dy); }
      else if (dir === 'up') { primary = -dy; cross = Math.abs(dx); }
      else { primary = dy; cross = Math.abs(dx); }
      if (primary <= 4) continue; // 必须在方向一侧
      const score = primary + cross * 2.2;
      if (score < bestScore) { bestScore = score; best = el; }
    }
    return best;
  }

  function move(dir) {
    const cur = document.activeElement;
    const els = focusables();
    if (!els.length) return;
    const curEl = (cur && cur.matches && cur.matches(SELECTOR)) ? cur : null;
    if (!curEl) { els[0].focus(); return; }
    const next = pick(curEl, dir);
    if (next) {
      next.focus();
      next.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
    }
  }

  function focusFirst(scope) {
    const els = focusables();
    if (els.length) {
      const el = scope ? els.find(e => scope.contains(e)) || els[0] : els[0];
      el.focus();
    }
  }

  document.addEventListener('keydown', e => {
    if (playerMode) return; // 播放器接管
    const k = e.key;
    if (k === 'ArrowLeft') { e.preventDefault(); move('left'); }
    else if (k === 'ArrowRight') { e.preventDefault(); move('right'); }
    else if (k === 'ArrowUp') { e.preventDefault(); move('up'); }
    else if (k === 'ArrowDown') { e.preventDefault(); move('down'); }
    else if (k === 'Enter') {
      const el = document.activeElement;
      if (el && el.matches && el.matches(SELECTOR)) { e.preventDefault(); el.click(); }
    }
    // Backspace / Esc 返回由 app.js 的路由处理
  });

  return {
    focusFirst, move,
    setModal: v => { modalLayer = v ? modalLayer + 1 : Math.max(0, modalLayer - 1); },
    setPlayer: v => { playerMode = v; },
  };
})();
