/* ================= UI 通用辅助 ================= */
/* 海报占位图(加载失败/无图时兜底) */
window.IMG_FB = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="450" viewBox="0 0 300 450">
    <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#1b2748"/><stop offset="1" stop-color="#0d1526"/>
    </linearGradient></defs>
    <rect width="300" height="450" fill="url(#g)"/>
    <text x="150" y="242" font-size="72" text-anchor="middle" opacity="0.45">🎬</text>
  </svg>`);
const IMG_ERR = 'onerror="this.onerror=null;this.src=window.IMG_FB"';

function toast(msg, type = '', dur = 0) {
  const box = document.getElementById('toasts');
  const t = document.createElement('div');
  t.className = 'toast ' + type;
  t.textContent = msg;
  box.appendChild(t);
  const life = dur || 3000;
  setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity .3s'; }, life - 400);
  setTimeout(() => t.remove(), life);
}

const UI = {
  el(html) { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstChild; },

  /* 海报卡片 */
  card(item) {
    const c = UI.el(`<div class="card" data-f tabindex="-1" data-id="${item.id}">
      <div class="poster">
        <img loading="lazy" src="${item.pic || window.IMG_FB}" ${IMG_ERR}>
        ${item.remarks ? `<div class="remark">${item.remarks}</div>` : ''}
      </div>
      <div class="title">${item.name}</div>
    </div>`);
    c.onclick = () => App.goDetail(item);
    return c;
  },

  /* 历史行 */
  histRow(h) {
    const pct = h.duration ? Math.min(100, h.position / h.duration * 100) : 0;
    const row = UI.el(`<div class="list-row" data-f tabindex="-1">
      <img src="${h.pic || window.IMG_FB}" ${IMG_ERR}>
      <div class="li-main">
        <div class="li-name">${h.name}</div>
        <div class="li-sub">看到 ${h.epName || ('第' + ((h.epIndex || 0) + 1) + '集')} · ${UI.fmtTime(h.position)} / ${UI.fmtTime(h.duration)}</div>
        <div class="pbar"><div style="width:${pct}%"></div></div>
      </div>
      <div class="li-ops">
        <button class="mini-btn" data-op="resume">续播</button>
        <button class="mini-btn danger" data-op="del">删除</button>
      </div>
    </div>`);
    row.onclick = e => {
      const op = e.target.dataset && e.target.dataset.op;
      if (op === 'del') { e.stopPropagation(); DB.removeHist(h.key); row.remove(); toast('已删除'); return; }
      App.resumeHist(h);
    };
    return row;
  },

  favRow(f) {
    const row = UI.el(`<div class="list-row" data-f tabindex="-1">
      <img src="${f.pic || window.IMG_FB}" ${IMG_ERR}>
      <div class="li-main">
        <div class="li-name">${f.name}</div>
        <div class="li-sub">来源:${f.sourceId === 'demo' ? '演示源' : f.sourceId}</div>
      </div>
      <div class="li-ops">
        <button class="mini-btn" data-op="open">打开</button>
        <button class="mini-btn danger" data-op="del">取消收藏</button>
      </div>
    </div>`);
    row.onclick = e => {
      const op = e.target.dataset && e.target.dataset.op;
      if (op === 'del') { e.stopPropagation(); DB.removeFav(f.key); row.remove(); toast('已取消收藏'); return; }
      App.openFromRecord(f);
    };
    return row;
  },

  fmtTime(s) {
    s = Math.max(0, Math.floor(s || 0));
    const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60);
    if (h) return `${h}小时${m}分`;
    return `${m}分${String(s % 60).padStart(2, '0')}秒`;
  },

  spinner() { return `<div class="spinner"></div>`; },

  empty(msg, btnText, onClick) {
    const d = UI.el(`<div class="empty"><div class="big">🍿</div><div>${msg}</div>${btnText ? `<button data-f tabindex="-1">${btnText}</button>` : ''}</div>`);
    if (btnText) d.querySelector('button').onclick = onClick;
    return d;
  },
};
