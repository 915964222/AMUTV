/* ================= 遥控器式方向键焦点导航 =================
 * ↑↓←→ 在可聚焦元素间按屏幕几何位置移动;
 * Enter/点击 确认;Backspace/Esc 返回。
 * ================================================= */
const KeyNav = (() => {
  const SELECTOR = '[data-f]';
  let modalLayer = 0; // 弹窗打开时,导航限制在弹窗内
  let playerMode = false; // 播放器有自己的按键逻辑
  let scopeEl = null; // 显式限定导航范围(如软键盘面板)
  let lastNavAt = 0; // 最近一次方向键导航时间(判断是否「遥控操作」)
  let lastFocus = null; // 记录上次聚焦的可导航元素,焦点丢失时就近恢复(P8)

  function focusables() {
    const scoped = scopeEl && document.contains(scopeEl) ? scopeEl : null;
    const root = scoped || (modalLayer > 0
      ? document.querySelector('.modal-mask, .pl-drawer') || document
      : document);
    return [...root.querySelectorAll(SELECTOR)].filter(el => {
      if (el.offsetParent !== null) return true;
      if (el === document.activeElement) return true;
      /* position:fixed 的元素 offsetParent 为 null,但确实显示在屏幕上(如详情页返回键) */
      const r = el.getBoundingClientRect();
      return r.width > 0 || r.height > 0;
    });
  }

  function center(el) {
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, r };
  }

  /* 同行/列重叠比:横向移动看纵向投影重叠、纵向移动看横向投影重叠,
   * 用「重叠高度 / 较小元素高度」的比例判断,比固定 6px 容差更适合有间隔的卡片网格,减少斜跳。 */
  function bandRatio(c, p, horiz) {
    let o, total;
    if (horiz) {
      o = Math.min(c.r.bottom, p.r.bottom) - Math.max(c.r.top, p.r.top);
      total = Math.min(c.r.height, p.r.height) || 1;
    } else {
      o = Math.min(c.r.right, p.r.right) - Math.max(c.r.left, p.r.left);
      total = Math.min(c.r.width, p.r.width) || 1;
    }
    if (o < 0 && -o <= 6) o = 0; // 微小间隙视为同行/列
    return o / total;
  }

  function pick(current, dir) {
    const c = center(current);
    const horiz = dir === 'left' || dir === 'right';
    let best = null, bestScore = Infinity;   // 同一行/列(投影重叠)的候选优先
    let fallback = null, fbScore = Infinity; // 没有同行的再按几何距离兜底
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
      /* 横向移动要求纵向有重叠、纵向移动要求横向有重叠,避免「斜着跳」到顶栏图标之类的元素上,
       * 让同一行的输入框/按钮优先被选中(搜索页的输入框以前就是这么跳不到的) */
      const sameBand = bandRatio(c, p, horiz) > 0.3;
      const score = primary + cross * 2.2;
      if (sameBand) {
        if (score < bestScore) { bestScore = score; best = el; }
      } else if (score < fbScore) {
        fbScore = score; fallback = el;
      }
    }
    return best || fallback;
  }

  /* 滚动到可见,并避开吸顶导航栏;同时避开吸底元素(如软键盘打开时),
   * 避免焦点被固定栏遮住。软键盘自身已做输入框避让,这里跳过键盘内元素。 */
  function ensureVisible(el) {
    try { el.scrollIntoView({ block: 'nearest', inline: 'nearest' }); } catch (e) {}
    const bar = document.getElementById('topbar');
    const barH = bar ? bar.getBoundingClientRect().bottom : 0;
    const r = el.getBoundingClientRect();
    if (barH && r.top < barH + 10) {
      try { window.scrollBy({ top: r.top - barH - 10, behavior: 'auto' }); } catch (e) { window.scrollBy(0, r.top - barH - 10); }
    }
    if (!el.closest || !el.closest('.osk')) {
      let bottomH = 0;
      const osk = document.querySelector('.osk.on');
      if (osk) bottomH = osk.getBoundingClientRect().top; // 其它固定底部元素可在此累加
      if (bottomH && r.bottom > bottomH - 8) {
        const d = r.bottom - bottomH + 8;
        try { window.scrollBy({ top: d, behavior: 'auto' }); } catch (e) { window.scrollBy(0, d); }
      }
    }
  }

  /* 整屏翻页:跳到「大约一屏距离」之外、且同方向最近的同排/同列元素(优先同排,避免斜跳)。
   * 用于长列表(首页推荐行 20+ 张卡)按住方向键时一次翻过一整屏。 */
  function pickPage(current, dir, distance) {
    const c = center(current);
    const horiz = dir === 'left' || dir === 'right';
    let sameBest = null, sameDist = Infinity;
    let anyBest = null, anyDist = Infinity;
    for (const el of focusables()) {
      if (el === current) continue;
      const p = center(el);
      const dx = p.x - c.x, dy = p.y - c.y;
      let primary = 0;
      if (dir === 'left') primary = -dx;
      else if (dir === 'right') primary = dx;
      else if (dir === 'up') primary = -dy;
      else primary = dy;
      if (primary <= 4) continue; // 必须在方向一侧
      const sameBand = bandRatio(c, p, horiz) > 0.3;
      const d = Math.abs(primary - distance); // 越接近「一屏距离」越优先
      if (sameBand) { if (d < sameDist) { sameDist = d; sameBest = el; } }
      else if (d < anyDist) { anyDist = d; anyBest = el; }
    }
    return sameBest || anyBest;
  }

  function move(dir, page) {
    lastNavAt = Date.now();
    const els = focusables();
    if (!els.length) return;
    const cur = document.activeElement;
    let curEl = (cur && cur.matches && cur.matches(SELECTOR)) ? cur : null;
    if (!curEl) {
      /* 焦点不在可导航元素上(刚关弹窗/焦点在隐藏元素):就近恢复到上次焦点再移动,
       * 而不是直接弹回页面第一个元素(P8)。 */
      if (lastFocus && els.indexOf(lastFocus) >= 0) curEl = lastFocus;
      else { els[0].focus(); return; }
    }
    const next = page
      ? pickPage(curEl, dir, (dir === 'left' || dir === 'right' ? window.innerWidth : window.innerHeight) * 0.85)
      : pick(curEl, dir);
    if (next && next !== curEl) {
      next.focus();
      lastFocus = next;
      ensureVisible(next);
    } else {
      lastFocus = curEl;
    }
  }

  function focusFirst(scope) {
    const els = focusables();
    if (els.length) {
      const el = scope ? els.find(e => scope.contains(e)) || els[0] : els[0];
      el.focus();
      lastFocus = el;
      ensureVisible(el);
    }
  }

  /* 长按方向键翻页:单击先走一格(即时响应),按住 500ms 后整屏翻页并持续翻,松开停止。
   * 用定时器接管,忽略系统自动重复(e.repeat),避免翻页太快/太慢不可控。 */
  let holdTimer = null;
  function clearHold() {
    if (holdTimer) { clearTimeout(holdTimer); clearInterval(holdTimer); holdTimer = null; }
  }
  document.addEventListener('keyup', clearHold);

  document.addEventListener('keydown', e => {
    if (playerMode) return; // 播放器接管
    const k = e.key;
    const dirMap = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' };
    if (k in dirMap) {
      e.preventDefault();
      const dir = dirMap[k];
      if (e.repeat) return; // 系统自动重复交给下面的定时器处理
      move(dir, false);     // 单击先走一格
      clearHold();
      holdTimer = setTimeout(() => {
        move(dir, true);    // 长按:先翻一整屏
        holdTimer = setInterval(() => move(dir, true), 420); // 之后每 420ms 翻一屏
      }, 500);
      return;
    }
    if (k === 'Enter') {
      const el = document.activeElement;
      if (el && el.matches && el.matches(SELECTOR)) { e.preventDefault(); el.click(); }
    }
    // Backspace / Esc 返回由 app.js 的路由处理
  });

  return {
    focusFirst, move,
    setModal: v => { modalLayer = v ? modalLayer + 1 : Math.max(0, modalLayer - 1); },
    /* 强制复位弹窗计数/作用域(异常后导航被卡住时调用恢复,见 P10) */
    resetModal: () => { modalLayer = 0; scopeEl = null; },
    setPlayer: v => { playerMode = v; },
    /* 限定导航范围:传元素=只在该元素内移动,传 null=恢复全页 */
    setScope: el => { scopeEl = el || null; },
    /* 最近 ms 毫秒内是否用方向键(遥控)移动过焦点 */
    remoteRecent: (ms = 1200) => Date.now() - lastNavAt < ms,
  };
})();
