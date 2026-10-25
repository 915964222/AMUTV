/* 云盘 4K 播放(阿里云盘扫码 / 夸克网盘 Cookie)
 * 账号存于 DB.config.clouds;access_token 内存缓存,过期自动 refresh。
 */
(function () {
  'use strict';
  const CACHE = {}; // kind → {access_token, drive_id, exp}
  /* 安卓 App(file://源)时云盘接口走本机内置服务器 */
  const SRV = location.protocol === 'file:' ? 'http://127.0.0.1:9978' : '';

  const Cloud = {
    list: function () { try { return DB.getConfig().clouds || []; } catch (e) { return []; } },
    save: function (arr) { DB.setConfig({ clouds: arr }); },

    /* 阿里:取 access_token(带缓存与自动续期) */
    aliToken: async function (refreshToken) {
      const c = CACHE['ali|' + refreshToken];
      if (c && c.exp > Date.now() + 60000) return c;
      const r = await fetch(SRV + '/cloud/ali/refresh', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: refreshToken }),
      }).then(x => x.json());
      if (!r.access_token) throw new Error('阿里 token 刷新失败:' + (r.message || JSON.stringify(r).slice(0, 120)));
      const t = { access_token: r.access_token, drive_id: r.default_drive_id, exp: Date.now() + (r.expires_in || 7200) * 1000 };
      CACHE['ali|' + refreshToken] = t;
      return t;
    },

    /* 登录流程 UI:在给定容器内渲染(阿里扫码 / 夸克贴 Cookie) */
    loginUI: function (box, done) {
      box.innerHTML = `
        <div class="cat-row" style="margin-bottom:12px">
          <button class="cat active" data-k="ali" data-f tabindex="-1">阿里云盘 · 扫码</button>
          <button class="cat" data-k="quark" data-f tabindex="-1">夸克网盘 · Cookie</button>
        </div>
        <div id="cloud-login-body"></div>`;
      const body = box.querySelector('#cloud-login-body');
      box.querySelector('.cat-row').onclick = e => {
        const b = e.target.closest('[data-k]'); if (!b) return;
        box.querySelectorAll('.cat').forEach(x => x.classList.remove('active'));
        b.classList.add('active');
        b.dataset.k === 'ali' ? aliLogin(body, done) : quarkLogin(body, done);
      };
      aliLogin(body, done);
    },
  };

  /* ---------- 阿里扫码 ---------- */
  async function aliLogin(body, done) {
    body.innerHTML = '<div class="hint">正在获取二维码…</div>';
    try {
      const qr = await fetch(SRV + '/cloud/ali/qr').then(r => r.json());
      if (!qr.sid) throw new Error(JSON.stringify(qr).slice(0, 120));
      const qrImg = 'https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=' + encodeURIComponent(qr.qrCodeUrl);
      body.innerHTML = `
        <div style="display:flex;gap:20px;align-items:center;flex-wrap:wrap">
          <img src="${qrImg}" style="width:220px;height:220px;border-radius:12px;background:#fff;padding:8px">
          <div style="max-width:320px">
            <div style="font-size:15px;margin-bottom:6px">打开 <b>阿里云盘 App</b> → 首页右上角「扫描」→ 扫描左侧二维码</div>
            <div class="hint" id="ali-st" style="margin-bottom:10px">等待扫码…</div>
            <div class="hint" style="font-size:12px">扫码授权后自动完成登录,Token 只保存在本机</div>
          </div>
        </div>`;
      const st = body.querySelector('#ali-st');
      let timer;
      const poll = async () => {
        try {
          const r = await fetch(SRV + '/cloud/ali/poll?sid=' + qr.sid).then(x => x.json());
          if (r.status === 'ScanSuccess') st.textContent = '已扫码,请在手机上确认授权…';
          if (r.status === 'LoginSuccess' && r.authCode) {
            clearInterval(timer);
            st.textContent = '授权成功,正在换取 Token…';
            const tk = await fetch(SRV + '/cloud/ali/token', {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ code: r.authCode }),
            }).then(x => x.json());
            if (!tk.refresh_token) throw new Error(JSON.stringify(tk).slice(0, 120));
            const arr = Cloud.list().filter(c => !(c.kind === 'ali' && c.refresh_token === tk.refresh_token));
            arr.push({ kind: 'ali', name: '阿里云盘', refresh_token: tk.refresh_token, ts: Date.now() });
            Cloud.save(arr);
            if (window.toast) toast('阿里云盘登录成功');
            done && done();
            return;
          }
          if (r.status === 'QRCodeExpired') { clearInterval(timer); st.textContent = '二维码已过期'; aliLogin(body, done); }
        } catch (e) { clearInterval(timer); st.textContent = '轮询失败:' + e.message; }
      };
      timer = setInterval(poll, 2500); poll();
    } catch (e) {
      body.innerHTML = '<div class="hint">获取二维码失败:' + e.message + '</div>';
    }
  }

  /* ---------- 夸克 Cookie ---------- */
  function quarkLogin(body, done) {
    body.innerHTML = `
      <div style="max-width:520px">
        <div style="font-size:14px;margin-bottom:8px">1. 电脑浏览器打开 <b>pan.quark.cn</b> 并登录 → 2. 按 F12 → Network(网络) → 刷新页面 → 任选一个请求 → 复制请求头里完整的 <b>Cookie</b> 值粘贴到下面</div>
        <textarea id="qk-ck" class="inp" style="width:100%;height:90px;margin:10px 0" placeholder="粘贴 Cookie(必须包含 __pus 与 __puus)"></textarea>
        <button class="btn primary" id="qk-ok" data-f tabindex="-1">验证并保存</button>
        <div class="hint" id="qk-st" style="margin-top:8px">Cookie 会保存在本机服务端,仅用于访问你的网盘文件</div>
      </div>`;
    body.querySelector('#qk-ok').onclick = async () => {
      const ck = body.querySelector('#qk-ck').value.trim();
      const st = body.querySelector('#qk-st');
      if (!/__puus=/.test(ck)) { st.textContent = 'Cookie 不完整:缺少 __puus'; return; }
      st.textContent = '正在验证…';
      try {
        const r = await fetch(SRV + '/cloud/quark/list?c=' + encodeURIComponent(ck) + '&p=0').then(x => x.json());
        if (r.error) throw new Error(r.error);
        const arr = Cloud.list().filter(c => !(c.kind === 'quark'));
        arr.push({ kind: 'quark', name: '夸克网盘', cookie: ck, ts: Date.now() });
        Cloud.save(arr);
        if (window.toast) toast('夸克网盘登录成功');
        done && done();
      } catch (e) { st.textContent = '验证失败:' + e.message; }
    };
  }

  /* ---------- 目录浏览(统一 list 形状:{list:[{name,dir,size,fid,url}]}) ---------- */
  Cloud.browse = async function (acct, fid) {
    if (acct.kind === 'ali') {
      const t = await Cloud.aliToken(acct.refresh_token);
      const r = await fetch(SRV + '/cloud/ali/list?t=' + t.access_token + '&d=' + t.drive_id + '&p=' + encodeURIComponent(fid || 'root')).then(x => x.json());
      if (r.error) throw new Error(r.error);
      r.drive_id = t.drive_id;
      return r;
    }
    const r = await fetch(SRV + '/cloud/quark/list?c=' + encodeURIComponent(acct.cookie) + '&p=' + encodeURIComponent(fid || '0')).then(x => x.json());
    if (r.error) throw new Error(r.error);
    return r;
  };

  /* 取可播直链(经 /cloud/dl 中转,支持 Range 与跨设备) */
  Cloud.playUrl = async function (acct, fid) {
    if (acct.kind === 'ali') {
      const t = await Cloud.aliToken(acct.refresh_token);
      const r = await fetch(SRV + '/cloud/ali/link?t=' + t.access_token + '&d=' + t.drive_id + '&fid=' + fid).then(x => x.json());
      if (r.error) throw new Error(r.error);
      return SRV + '/cloud/dl?u=' + encodeURIComponent(r.url) + '&h=0';
    }
    const r = await fetch(SRV + '/cloud/quark/link?c=' + encodeURIComponent(acct.cookie) + '&fid=' + fid).then(x => x.json());
    if (r.error) throw new Error(r.error);
    return SRV + '/cloud/dl?u=' + encodeURIComponent(r.url) + '&h=1';
  };

  window.Cloud = Cloud;
})();
