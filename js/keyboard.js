/* ================= 遥控软键盘(OSK) =================
 * 遥控器方向键把焦点移到输入框时,自动弹出屏幕键盘;
 * 键盘内用方向键移动、Enter 输入,Backspace 删除,Esc/完成 收起。
 * 也可从「设置 → 遥控输入自动弹键盘」关闭。
 * ================================================= */
window.OSK = (() => {
  const ROWS_ABC = [
    ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'],
    ['q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p'],
    ['a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l', '-'],
    [{ t: '⇧', a: 'shift' }, 'z', 'x', 'c', 'v', 'b', 'n', 'm', '.', { t: '⌫', a: 'back' }],
    [{ t: '符号', a: 'sym' }, { t: '空格', a: 'space', w: 1.6 }, { t: '◀', a: 'curL' }, { t: '▶', a: 'curR' }, { t: '清空', a: 'clear' }, { t: '完成', a: 'done' }],
  ];
  const ROWS_SYM = [
    ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'],
    ['-', '_', ':', '/', '.', '?', '=', '&', '%', '#'],
    ['@', '+', '~', ',', ';', "'", '"', '(', ')', '*'],
    [{ t: 'ABC', a: 'abc' }, '[', ']', '{', '}', '<', '>', '|', '\\', { t: '⌫', a: 'back' }],
    [{ t: '字母', a: 'abc' }, { t: '空格', a: 'space', w: 1.6 }, { t: '◀', a: 'curL' }, { t: '▶', a: 'curR' }, { t: '清空', a: 'clear' }, { t: '完成', a: 'done' }],
  ];
  const TEXT_TYPES = ['text', 'search', 'url', 'password', 'email', 'number', 'tel', ''];

  let panel = null, cur = null, open = false, sym = false, shift = false;
  let selfFocus = null; // 由我们自己回焦的元素:这一次 focus 不再重复弹键盘

  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  function isTextInput(el) {
    if (!el || el.nodeType !== 1) return false;
    if (el.tagName === 'TEXTAREA') return true;
    if (el.tagName !== 'INPUT') return false;
    return TEXT_TYPES.indexOf((el.getAttribute('type') || 'text').toLowerCase()) >= 0;
  }

  function enabled() {
    try { return DB.getConfig().autoKeyboard !== false; } catch (e) { return true; }
  }
  /* 电视端(App 内)总是弹;浏览器里只在用方向键导航到输入框时弹,鼠标点击不弹 */
  function isTV() { return !!(window.YSTV && window.YSTV.showIme); }

  function rowHtml(row) {
    return '<div class="osk-row">' + row.map(k => {
      if (typeof k === 'string') {
        const label = shift && /^[a-z]$/.test(k) ? k.toUpperCase() : k;
        return `<button class="osk-k" data-f tabindex="-1" data-k="${esc(k)}">${esc(label)}</button>`;
      }
      const style = k.w ? ` style="flex:${k.w}"` : '';
      return `<button class="osk-k osk-act" data-f tabindex="-1" data-a="${k.a}"${style}>${k.t}</button>`;
    }).join('') + '</div>';
  }

  function build() {
    panel = document.createElement('div');
    panel.className = 'osk';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', '遥控软键盘');
    panel.innerHTML = `
      <div class="osk-head">
        <span class="osk-t">遥控输入</span>
        <span class="osk-hint">方向键选键 · Enter 输入 · ◀▶ 移光标 · Esc 收起</span>
        <span class="osk-val" id="osk-val"></span>
      </div>
      <div class="osk-rows"></div>`;
    document.body.appendChild(panel);

    panel.addEventListener('click', e => {
      const k = e.target.closest('.osk-k');
      if (!k) return;
      press(k);
    });
    /* 键盘内导航用 KeyNav.move,但键盘外(播放器等)可能关掉了 KeyNav,这里自己兜住方向键 */
    panel.addEventListener('mousedown', e => { if (e.target.closest('.osk-k')) e.preventDefault(); });
  }

  function rowsFor() {
    const rows = (sym ? ROWS_SYM : ROWS_ABC).map(r => r.slice());
    /* 电视端若有系统输入法,给一个切中文的入口 */
    if (window.YSTV && window.YSTV.showIme) rows[rows.length - 1].push({ t: '系统', a: 'ime' });
    return rows;
  }

  function render() {
    panel.querySelector('.osk-rows').innerHTML = rowsFor().map(rowHtml).join('');
  }

  function focusKey(name) {
    const k = panel && panel.querySelector(`.osk-k[data-a="${name}"]`);
    if (k) k.focus();
  }

  function updateVal() {
    const v = panel && panel.querySelector('#osk-val');
    if (!v) return;
    const s = cur ? cur.value : '';
    v.textContent = s ? (s.length > 26 ? '…' + s.slice(-26) : s) : '等待输入';
  }

  /* ---------- 文本操作 ---------- */
  function sel(el) {
    let s = el.value.length, e = s;
    try {
      if (typeof el.selectionStart === 'number') { s = el.selectionStart; e = el.selectionEnd; }
    } catch (err) {}
    return [s, e];
  }
  function setCaret(el, p) {
    try { el.setSelectionRange(p, p); } catch (err) {}
  }
  function fire(el) {
    el.dispatchEvent(new Event('input', { bubbles: true }));
    updateVal();
  }
  function type(ch) {
    const el = cur;
    if (!el || !document.contains(el)) { close(); return; }
    const [s, e] = sel(el);
    el.value = el.value.slice(0, s) + ch + el.value.slice(e);
    setCaret(el, s + ch.length);
    fire(el);
  }
  function backspace() {
    const el = cur;
    if (!el || !document.contains(el)) { close(); return; }
    let [s, e] = sel(el);
    if (s === e && s > 0) s -= 1;
    el.value = el.value.slice(0, s) + el.value.slice(e);
    setCaret(el, s);
    fire(el);
  }
  function clearAll() {
    const el = cur;
    if (!el) return;
    el.value = '';
    setCaret(el, 0);
    fire(el);
  }
  /* 移动文本光标(不删字):框选时先收拢到端点再按方向挪一格 */
  function caretBy(delta) {
    const el = cur;
    if (!el || !document.contains(el)) { close(); return; }
    let [s, e] = sel(el);
    const pos = (s === e) ? s : (delta < 0 ? s : e);
    const np = Math.max(0, Math.min(el.value.length, pos + delta));
    setCaret(el, np);
    updateVal();
  }

  /* ---------- 按键分发 ---------- */
  function press(k) {
    const a = k.dataset.a;
    if (!a) {
      const ch = k.dataset.k;
      type(shift && /^[a-z]$/.test(ch) ? ch.toUpperCase() : ch);
      k.focus();
      return;
    }
    if (a === 'back') { backspace(); k.focus(); return; }
    if (a === 'space') { type(' '); k.focus(); return; }
    if (a === 'curL') { caretBy(-1); k.focus(); return; }
    if (a === 'curR') { caretBy(1); k.focus(); return; }
    if (a === 'clear') { clearAll(); k.focus(); return; }
    if (a === 'done') { done(); return; }
    if (a === 'shift') { shift = !shift; render(); focusKey('shift'); return; }
    if (a === 'sym') { sym = true; shift = false; render(); focusKey('sym'); return; }
    if (a === 'abc') { sym = false; render(); focusKey('abc'); return; }
    if (a === 'ime') { sysIme(); return; }
  }

  /* 完成 = 收起键盘 + 回焦输入框 + 触发一次 Enter(搜索页可直接出结果) */
  function done() {
    const el = cur;
    close();
    if (el && document.contains(el)) {
      setTimeout(() => {
        try { el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); } catch (e) {}
      }, 30);
    }
  }

  /* 回焦输入框:这一次聚焦是我们自己触发的,不该再弹一次键盘 */
  function selfFocusTo(el) {
    selfFocus = el;
    setTimeout(() => { if (selfFocus === el) selfFocus = null; }, 600);
    try { el.focus(); } catch (e) {}
  }

  /* 切到系统输入法(电视盒子自带中文输入时用) */
  function sysIme() {
    const el = cur;
    close(false);
    if (!el || !document.contains(el)) return;
    selfFocusTo(el);
    setTimeout(() => {
      try { if (window.YSTV && window.YSTV.showIme) window.YSTV.showIme(); } catch (e) {}
    }, 80);
  }

  /* ---------- 开/关 ---------- */
  function show(el) {
    if (!isTextInput(el) || !enabled()) return;
    if (open && cur === el) return;
    if (cur && cur !== el) cur.classList.remove('osk-target');
    cur = el;
    if (!panel) build();
    sym = false;
    shift = false;
    render();
    panel.classList.add('on');
    open = true;
    document.body.classList.add('osk-on');
    el.classList.add('osk-target');
    KeyNav.setScope(panel);
    updateVal();
    const first = panel.querySelector('.osk-k');
    if (first) first.focus();
    keepVisible(el);
    /* 电视端:确保系统输入法不会同时冒出来(否则两个键盘打架) */
    hideIme();
    setTimeout(hideIme, 120);
    setTimeout(hideIme, 420);
  }

  /* 把正在编辑的输入框挪到键盘上方(等面板动画/底部留白生效后再算一次) */
  function keepVisible(el) {
    const to = () => {
      const r = el.getBoundingClientRect();
      const panelTop = window.innerHeight - (panel ? panel.offsetHeight : 290);
      const topLimit = 96;
      if (r.top >= topLimit && r.bottom <= panelTop - 18) return; // 已经完整可见
      const target = Math.max(topLimit, (panelTop - r.height) / 2);
      const delta = r.top - target;
      try { window.scrollBy({ top: delta, behavior: 'auto' }); } catch (e) { window.scrollBy(0, delta); }
    };
    to();
    setTimeout(to, 260);
  }

  function hideIme() {
    try { if (window.YSTV && window.YSTV.hideIme) window.YSTV.hideIme(); } catch (e) {}
  }

  function close(refocus) {
    if (!open) return;
    const el = cur;
    open = false;
    cur = null;
    if (el) el.classList.remove('osk-target');
    if (panel) panel.classList.remove('on');
    document.body.classList.remove('osk-on');
    KeyNav.setScope(null);
    hideIme();
    if (refocus !== false && el && document.contains(el)) selfFocusTo(el);
  }

  /* ---------- 自动弹出 ---------- */
  document.addEventListener('focusin', e => {
    const t = e.target;
    if (panel && panel.contains(t)) return;
    if (!isTextInput(t)) { if (open) close(false); return; }
    if (t === selfFocus) { selfFocus = null; return; }
    if (!enabled()) return;
    if (!isTV() && !KeyNav.remoteRecent(1200)) return; // 浏览器鼠标点击不弹
    show(t);
  });

  /* 键盘打开期间接管按键:方向键在键盘内移动,Backspace 删除,Esc 收起;
   * 收起后在输入框上按 Enter(OK)可重新唤起。
   * 监听挂在 window 捕获阶段:比播放器(document 捕获)更早,避免一边调进度一边选字 */
  window.addEventListener('keydown', e => {
    const k = e.key;

    if (!open) {
      if (k !== 'Enter' || !e.isTrusted) return; // 只认真实按键(避免「完成」里合成的 Enter 又弹一次)
      const ae = document.activeElement;
      if (!isTextInput(ae) || !enabled()) return;
      if (!isTV() && !KeyNav.remoteRecent(3000)) return;
      e.preventDefault(); e.stopPropagation();
      show(ae);
      return;
    }

    if (k === 'ArrowLeft' || k === 'ArrowRight' || k === 'ArrowUp' || k === 'ArrowDown') {
      e.preventDefault(); e.stopPropagation();
      KeyNav.move({ ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' }[k]);
      return;
    }
    if (k === 'Enter') {
      const ae = document.activeElement;
      if (ae && ae.classList && ae.classList.contains('osk-k')) {
        e.preventDefault(); e.stopPropagation();
        ae.click();
      }
      return;
    }
    if (k === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); return; }
    if (k === 'Backspace') { e.preventDefault(); e.stopPropagation(); backspace(); return; }
    if (k === 'Tab') { e.preventDefault(); e.stopPropagation(); KeyNav.move(e.shiftKey ? 'left' : 'right'); return; }
    /* 有物理键盘时直接打字 */
    if (k && k.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault(); e.stopPropagation();
      type(k);
    }
  }, true);

  return { show, close, isOpen: () => open };
})();
