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
        stopLogin();
        b.dataset.k === 'ali' ? aliLogin(body, done) : quarkLogin(body, done);
      };
      aliLogin(body, done);
    },
  };

  /* ---------- 阿里扫码 ---------- */
  let aliPoll = null, aliCd = null, aliBusy = false;
  function stopLogin() {
    if (aliPoll) { clearInterval(aliPoll); aliPoll = null; }
    if (aliCd) { clearInterval(aliCd); aliCd = null; }
    aliBusy = false;
  }
  Cloud.stopLogin = stopLogin;

  /* 本地画二维码(不依赖第三方图床,任意分辨率都清晰) */
  function qrSvg(text) {
    if (!window.qrcode) return '';
    try {
      const q = window.qrcode(0, 'M');
      q.addData(text);
      q.make();
      return q.createSvgTag({ cellSize: 4, margin: 16, scalable: true });
    } catch (e) { return ''; }
  }

  const QR_LIFE = 120;  // 秒:官方 180 秒过期,提前换新
  const QR_KEEP = 170;  // 秒:旧码继续轮询到这个年龄(手机上确认的可能就是刚换掉那张)

  async function aliLogin(body, done) {
    stopLogin();
    body.innerHTML = `
      <div class="ali-login">
        <div class="ali-qr-col">
          <div class="ali-qr" id="ali-qr"><div class="hint">正在获取二维码…</div></div>
          <div class="ali-st" id="ali-st">正在获取二维码…</div>
          <div class="ali-bar">
            <button class="btn" id="ali-refresh" data-f tabindex="-1">刷新二维码</button>
            <span class="ali-cd" id="ali-cd"></span>
          </div>
        </div>
        <div class="ali-side">
          <div class="ali-steps">
            <b>扫码步骤</b>
            <div>1 · 手机上打开 <b>阿里云盘 App</b></div>
            <div>2 · 首页右上角「扫描」→ 扫左边二维码</div>
            <div>3 · 手机上点「确认登录」</div>
            <div class="hint" style="margin-top:6px">必须用 App 内的「扫描」;用相机/微信扫只会打开网页,不会登录</div>
          </div>
          <button class="ali-alt" id="ali-alt" data-f tabindex="-1">扫码一直不行?改用 refresh_token 登录 ›</button>
        </div>
      </div>
      <div id="ali-alt-box"></div>`;

    const st = body.querySelector('#ali-st');
    const cd = body.querySelector('#ali-cd');
    const qrBox = body.querySelector('#ali-qr');
    const altBox = body.querySelector('#ali-alt-box');

    let sids = [];        // [{sid,born}] 当前码 + 上一张码
    let scanned = false;
    let finished = false;
    let errCount = 0;

    const setSt = (txt, cls) => { st.textContent = txt; st.className = 'ali-st' + (cls ? ' ' + cls : ''); };

    body.querySelector('#ali-refresh').onclick = () => { setSt('正在刷新二维码…'); newQr(); };
    body.querySelector('#ali-alt').onclick = () => altLogin(altBox, done);
    newQr();

    async function newQr() {
      if (finished) return;
      cd.textContent = '';
      let qr = null;
      try {
        qr = await fetch(SRV + '/cloud/ali/qr?_t=' + Date.now(), { cache: 'no-store' }).then(r => r.json());
      } catch (e) {
        setSt('取二维码失败:' + e.message + '(本机服务是否在运行?)', 'err');
        return;
      }
      if (!qr || !qr.sid) {
        setSt('取二维码失败:' + JSON.stringify(qr || {}).slice(0, 140), 'err');
        return;
      }
      qrBox.innerHTML = qrSvg(qr.qrCodeUrl) || '<div class="hint">二维码组件未加载</div>';
      setSt('等待扫码…');
      sids = [{ sid: qr.sid, born: Date.now() }].concat(sids.slice(0, 1));
      if (!aliPoll) aliPoll = setInterval(pollAll, 2500);
      if (!aliCd) aliCd = setInterval(tickCd, 1000);
      tickCd();
      pollAll();
    }

    function tickCd() {
      if (finished || !sids.length) return;
      if (scanned) { cd.textContent = '已扫码,等待手机确认…'; return; }
      const left = QR_LIFE - Math.floor((Date.now() - sids[0].born) / 1000);
      if (left <= 0) { cd.textContent = '正在换新码…'; newQr(); return; }
      cd.textContent = '二维码 ' + left + ' 秒后自动刷新';
    }

    async function pollAll() {
      if (finished || aliBusy) return;
      aliBusy = true;
      try {
        const now = Date.now();
        sids = sids.filter((x, i) => i === 0 || now - x.born < QR_KEEP * 1000);
        for (const item of sids.slice()) {
          let r = null;
          try {
            /* 带 _t + no-store:防止 WebView/代理缓存住第一次的 WaitLogin */
            r = await fetch(SRV + '/cloud/ali/poll?sid=' + encodeURIComponent(item.sid) + '&_t=' + Date.now(), { cache: 'no-store' }).then(x => x.json());
            errCount = 0;
          } catch (e) {
            if (++errCount >= 3) setSt('轮询失败:' + e.message + '(连不上本机服务?)', 'err');
            continue;
          }
          const status = r && r.status;
          if (status === 'ScanSuccess') {
            scanned = true;
            setSt('已扫码,请在手机上点「确认登录」…');
          } else if (status === 'LoginSuccess') {
            if (!r.authCode) { setSt('手机已授权,但没拿到授权码,继续重试…'); continue; }
            await exchange(r.authCode);
            return;
          } else if (status === 'QRCodeExpired') {
            const isCur = item === sids[0];
            sids = sids.filter(x => x !== item);
            if (isCur) { setSt('二维码已过期,正在换新…'); newQr(); }
          } else if (status === 'WaitLogin') {
            if (!scanned && st.textContent !== '等待扫码…') setSt('等待扫码…');
          } else if (status) {
            setSt('状态:' + status);
          } else {
            setSt('状态查询异常:' + String((r && (r.error || r.message)) || JSON.stringify(r)).slice(0, 140), 'err');
          }
        }
      } finally {
        aliBusy = false;
      }
    }

    async function exchange(code) {
      finished = true;
      stopLogin();
      setSt('授权成功,正在换取 Token…');
      let last = '';
      for (let i = 0; i < 2; i++) {
        try {
          const tk = await fetch(SRV + '/cloud/ali/token', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ code }), cache: 'no-store',
          }).then(x => x.json());
          if (tk && tk.refresh_token) {
            const arr = Cloud.list().filter(c => !(c.kind === 'ali' && c.refresh_token === tk.refresh_token));
            arr.push({ kind: 'ali', name: '阿里云盘', refresh_token: tk.refresh_token, ts: Date.now() });
            Cloud.save(arr);
            setSt('登录成功 ✓', 'ok');
            cd.textContent = '';
            if (window.toast) toast('阿里云盘登录成功');
            done && done();
            return;
          }
          last = JSON.stringify(tk).slice(0, 140);
        } catch (e) { last = e.message; }
        await new Promise(r => setTimeout(r, 900));
      }
      finished = false;
      cd.textContent = '';
      setSt('换取 Token 失败:' + last + ' — 可改用下方 refresh_token 登录', 'err');
      if (!aliPoll) aliPoll = setInterval(pollAll, 2500);
      if (!aliCd) aliCd = setInterval(tickCd, 1000);
    }
  }

  /* ---------- 阿里:直接贴 refresh_token(扫码不可用时的兜底) ---------- */
  function altLogin(box, done) {
    if (box.dataset.on === '1') { box.dataset.on = '0'; box.innerHTML = ''; return; }
    box.dataset.on = '1';
    box.innerHTML = `
      <div class="form" style="margin-top:12px">
        <input id="ali-rt" data-f tabindex="-1" placeholder="粘贴阿里云盘 refresh_token(约 300 字符)">
        <button class="btn primary" id="ali-rt-ok" data-f tabindex="-1">验证并保存</button>
      </div>
      <div class="hint" id="ali-rt-st">获取方式:电脑浏览器打开阿里云盘网页版登录后,F12 → Network → 找 token 请求 → 复制返回里的 <b>refresh_token</b>;或用 aliyundrive-webdav 的 token 工具。只保存在本机。</div>`;
    const inp = box.querySelector('#ali-rt');
    const st = box.querySelector('#ali-rt-st');
    if (inp) setTimeout(() => { try { inp.focus(); } catch (e) {} }, 60);
    box.querySelector('#ali-rt-ok').onclick = async () => {
      const rt = inp.value.trim();
      if (rt.length < 50) { st.textContent = 'refresh_token 太短,请检查是否复制完整'; return; }
      st.textContent = '正在验证…';
      try {
        const r = await fetch(SRV + '/cloud/ali/refresh', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refresh_token: rt }),
        }).then(x => x.json());
        if (!r.access_token) { st.textContent = '验证失败:' + JSON.stringify(r).slice(0, 140); return; }
        const arr = Cloud.list().filter(c => !(c.kind === 'ali' && c.refresh_token === rt));
        arr.push({ kind: 'ali', name: '阿里云盘', refresh_token: rt, ts: Date.now() });
        Cloud.save(arr);
        st.textContent = '登录成功 ✓';
        stopLogin();
        if (window.toast) toast('阿里云盘登录成功');
        done && done();
      } catch (e) { st.textContent = '验证失败:' + e.message; }
    };
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
