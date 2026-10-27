/* 云盘 4K 播放(阿里云盘扫码 / 夸克网盘扫码,两者都可退回 refresh_token / Cookie)
 * 账号存于 DB.config.clouds;access_token 内存缓存,过期自动 refresh。
 */
(function () {
  'use strict';
  const CACHE = {}; // kind → {access_token, drive_id, exp}
  /* 安卓 App(file://源)时云盘接口走本机内置服务器。
     用 localhost 而非 127.0.0.1:Chromium 按 host 分连接池(每 host 6 条),
     /cloud/ali/poll 长轮询会占住连接,与 API 主池(127.0.0.1)隔离避免饿死 sniff2/proxy */
  const SRV = location.protocol === 'file:' ? 'http://localhost:9978' : '';

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
      /* 阿里云盘的 refresh_token 是一次性轮换的:每刷新一次就可能发一个新的,旧的立刻作废。
         不回写的话,第二天再打开就是 RefreshTokenInvalid —— 表现成「明明登过却一直登不上、看不到网盘」。 */
      if (r.refresh_token && r.refresh_token !== refreshToken) {
        try {
          const arr = Cloud.list().map(c0 => (c0.kind === 'ali' && c0.refresh_token === refreshToken)
            ? Object.assign({}, c0, { refresh_token: r.refresh_token, ts: Date.now() }) : c0);
          Cloud.save(arr);
        } catch (e) { /* 存不进去也不影响本次使用 */ }
      }
      const t = {
        access_token: r.access_token,
        drive_id: r.default_drive_id || r.drive_id || '',
        exp: Date.now() + (r.expires_in || 7200) * 1000,
      };
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
        b.dataset.k === 'ali' ? aliLogin(body, done) : quarkCookie(body, done);
      };
      aliLogin(body, done);
    },
  };

  /* ---------- 阿里扫码 ---------- */
  let aliPoll = null, aliCd = null, aliBusy = false;
  let qkPoll = null, qkCd = null, qkBusy = false;
  function stopLogin() {
    if (aliPoll) { clearInterval(aliPoll); aliPoll = null; }
    if (aliCd) { clearInterval(aliCd); aliCd = null; }
    if (qkPoll) { clearInterval(qkPoll); qkPoll = null; }
    if (qkCd) { clearInterval(qkCd); qkCd = null; }
    aliBusy = false;
    qkBusy = false;
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

  /* 官方码 180 秒过期。原来 120 秒就换,用户还在找手机/开 App 码就变了,
     扫到的往往是刚换掉那张 → 手机上直接报「二维码已失效」。留到 168 秒再换。
     另一条:一旦已扫码就绝不再换码(否则手机上点确认时码已经作废)。 */
  const QR_LIFE = 168;  // 秒:自动换新码
  const QR_KEEP = 210;  // 秒:旧码继续轮询到这个年龄(手机上确认的可能就是刚换掉那张)

  async function aliLogin(body, done) {
    stopLogin();
    body.innerHTML = `
      <div class="ali-login">
        <div class="ali-qr-col">
          <div class="ali-qr" id="ali-qr" title="点一下放大 / 缩小"><div class="hint">正在获取二维码…</div></div>
          <div class="ali-st" id="ali-st">正在获取二维码…</div>
          <div class="ali-bar">
            <button class="btn" id="ali-refresh" data-f tabindex="-1">刷新二维码</button>
            <span class="ali-cd" id="ali-cd"></span>
          </div>
          <div class="hint" style="font-size:12.5px">点二维码可放大(离得远也能扫)</div>
        </div>
        <div class="ali-side">
          <div class="ali-steps">
            <b>扫码步骤</b>
            <div>1 · 手机上打开 <b>阿里云盘 App</b>(不是微信、不是相机)</div>
            <div>2 · App 首页右上角「<b>+</b>」→「<b>扫一扫</b>」</div>
            <div>3 · 对准本页二维码 → 手机上点「<b>确认登录</b>」</div>
            <div class="ali-warn">
              ⚠ 只认 App 里的「扫一扫」。用相机 / 微信 / 系统相册扫,手机上只会出现<strong>一张二维码图片</strong>,
              那是阿里返回的图,里面没有登录确认按钮,所以永远登不上。
            </div>
          </div>
          <div class="ali-tip" id="ali-tip"></div>
          <button class="ali-alt" id="ali-alt" data-f tabindex="-1">手机上没有阿里云盘 / 扫码一直不行?改用 refresh_token 登录 ›</button>
        </div>
      </div>
      <div id="ali-alt-box"></div>`;

    const st = body.querySelector('#ali-st');
    const cd = body.querySelector('#ali-cd');
    const qrBox = body.querySelector('#ali-qr');
    const tip = body.querySelector('#ali-tip');
    const altBox = body.querySelector('#ali-alt-box');

    let sids = [];        // [{sid,born}] 当前码 + 上一张码
    let scanned = false;
    let finished = false;
    let errCount = 0;
    let firstQrAt = 0;    // 第一次出码的时间,用来算「多久没扫上」

    const setSt = (txt, cls) => { st.textContent = txt; st.className = 'ali-st' + (cls ? ' ' + cls : ''); };
    const setTip = (html) => { if (!tip) return; tip.innerHTML = html || ''; tip.style.display = html ? 'block' : 'none'; };
    setTip('');

    /* 电视离沙发两三米,248px 的码对焦很吃力:点一下放大到 420px */
    qrBox.onclick = () => {
      const big = qrBox.classList.toggle('big');
      if (big) setTip('已放大。再点一次可缩小。');
    };

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
      if (!firstQrAt) firstQrAt = Date.now();
      sids = [{ sid: qr.sid, born: Date.now() }].concat(sids.slice(0, 1));
      if (!aliPoll) aliPoll = setInterval(pollAll, 2500);
      if (!aliCd) aliCd = setInterval(tickCd, 1000);
      tickCd();
      pollAll();
    }

    function tickCd() {
      if (finished || !sids.length) return;
      if (scanned) { cd.textContent = '已扫码,等待手机确认…'; setTip(''); return; }
      const age = Math.floor((Date.now() - firstQrAt) / 1000);
      /* 25 秒还没扫上:极可能是用相机/微信扫的(手机上只剩一张图片),直接点出来 */
      if (age > 25) {
        setTip(qrBox.classList.contains('big')
          ? '还没识别到扫码。二维码已放大,请让手机重新对准屏幕中间再扫一次。' +
            '<br>用<b>相机 / 微信 / 相册</b>扫只会得到一张图片,必须用<b>阿里云盘 App 内的「扫一扫」</b>。'
          : '还没识别到扫码。如果手机上打开的是一张<b>二维码图片</b>(顶部一串 1793… 的编号),' +
            '那说明用的是相机 / 微信 / 相册 —— 请改用<b>阿里云盘 App 内的「扫一扫」</b>。' +
            '<br>也可以点一下二维码放大后重扫。');
      }
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
            const acct = { kind: 'ali', name: '阿里云盘', refresh_token: tk.refresh_token, ts: Date.now() };
            const arr = Cloud.list().filter(c => !(c.kind === 'ali' && c.refresh_token === tk.refresh_token));
            arr.push(acct);
            Cloud.save(arr);
            cd.textContent = '';
            /* 拿到 token 不等于能用:立刻真读一次根目录。
               网盘被限流、授权范围不够、接口变更,只有这一步才暴露;
               不然用户回到网盘页只看到「访问失败」,根本不知道是登录的问题。 */
            setSt('登录成功,正在读取网盘…', 'ok');
            let items = null, err2 = '';
            try {
              const rr = await Cloud.browse(acct, 'root');
              items = (rr && rr.list) || [];
            } catch (e2) { err2 = (e2 && e2.message) || String(e2); }
            if (items) {
              setSt('登录成功 ✓ 根目录 ' + items.length + ' 项', 'ok');
              if (window.toast) toast('阿里云盘登录成功,去「网盘」页看文件');
            } else {
              setSt('已保存账号,但读取网盘失败:' + err2, 'err');
              if (window.toast) toast('登录成功,但读取网盘失败', 'err');
            }
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
      <div class="hint" id="ali-rt-st">获取方式:电脑浏览器登录 <b>www.alipan.com</b> → F12 → Application → Local Storage → 找 <b>token</b> 里的 <b>refresh_token</b>;或用 aliyundrive-webdav 的 token 工具。只保存在本机。</div>`;
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
        /* 阿里 refresh_token 会轮换:验证时返回的新 token 才是能长期用的那个 */
        const keep = (r.refresh_token && r.refresh_token.length > 50) ? r.refresh_token : rt;
        arr.push({ kind: 'ali', name: '阿里云盘', refresh_token: keep, ts: Date.now() });
        Cloud.save(arr);
        st.textContent = '登录成功 ✓ 正在读取网盘…';
        /* 当场读一次根目录:能读到才算真登上了,别又变成「提示成功但一片空白」 */
        try {
          const root = await Cloud.browse({ kind: 'ali', refresh_token: keep }, 'root');
          const n = (root && root.list) ? root.list.length : 0;
          st.textContent = '登录成功 ✓ 根目录 ' + n + ' 项';
        } catch (e2) {
          st.textContent = '已保存账号,但读取网盘失败:' + e2.message;
        }
        stopLogin();
        if (window.toast) toast('阿里云盘登录成功');
        done && done();
      } catch (e) { st.textContent = '验证失败:' + e.message; }
    };
  }

  /* ---------- 夸克:Cookie 登录 ---------- */
  function quarkCookie(body, done) {
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
  /* 阿里 OpenAPI 的错误体是 {code,message,requestId},不是 {error}。
     以前只判 r.error,于是 401/400 被当成「空目录」,用户看到的就是「网盘里什么都没有」。 */
  function mustOk(r) {
    if (!r || typeof r !== 'object') return r;
    if (r.error) throw new Error(String(r.error));
    if (r.code && r.message && !r.list) throw new Error(r.code + ': ' + r.message);
    return r;
  }

  Cloud.browse = async function (acct, fid) {
    if (acct.kind === 'ali') {
      const t = await Cloud.aliToken(acct.refresh_token);
      const raw = mustOk(await fetch(SRV + '/cloud/ali/list?t=' + encodeURIComponent(t.access_token) +
        '&d=' + encodeURIComponent(t.drive_id || '') + '&p=' + encodeURIComponent(fid || 'root')).then(x => x.json()));
      /* 阿里 openFile/list 返回的是 {items:[{file_id,name,type,size}]},
         既不是 list,字段也不是 fid/dir —— 必须在这里翻译成 UI 认识的形状。
         以前直接读 r.list,结果永远是「此目录为空」:登录明明成功,却一个文件都看不到。 */
      const items = raw.items || raw.list || [];
      return {
        drive_id: t.drive_id,
        list: items.map(it => ({
          name: it.name || it.file_name || '',
          dir: it.type === 'folder' || it.type === 'dir' || !!it.dir,
          size: it.size || 0,
          fid: it.file_id || it.fid || '',
        })),
      };
    }
    const raw = mustOk(await fetch(SRV + '/cloud/quark/list?c=' + encodeURIComponent(acct.cookie) + '&p=' + encodeURIComponent(fid || '0')).then(x => x.json()));
    /* 夸克是 {status,code,data:{list:[{file_name,dir,size,fid}]}},同样要翻译 */
    const d = raw.data || {};
    const items = raw.list || d.list || (Array.isArray(d) ? d : []);
    return {
      list: items.map(it => ({
        name: it.file_name || it.name || '',
        dir: !!it.dir,
        size: it.size || 0,
        fid: it.fid || it.file_id || '',
      })),
    };
  };

  /* 取可播直链(经 /cloud/dl 中转,支持 Range 与跨设备) */
  Cloud.playUrl = async function (acct, fid) {
    if (acct.kind === 'ali') {
      const t = await Cloud.aliToken(acct.refresh_token);
      const r = mustOk(await fetch(SRV + '/cloud/ali/link?t=' + encodeURIComponent(t.access_token) +
        '&d=' + encodeURIComponent(t.drive_id || '') + '&fid=' + encodeURIComponent(fid)).then(x => x.json()));
      if (!r.url) throw new Error('没有拿到播放直链:' + JSON.stringify(r).slice(0, 120));
      return SRV + '/cloud/dl?u=' + encodeURIComponent(r.url) + '&h=0';
    }
    const r = mustOk(await fetch(SRV + '/cloud/quark/link?c=' + encodeURIComponent(acct.cookie) + '&fid=' + encodeURIComponent(fid)).then(x => x.json()));
    const u = r.url || (r.data && r.data[0] && r.data[0].download_url);
    if (!u) throw new Error('没有拿到播放直链:' + JSON.stringify(r).slice(0, 120));
    return SRV + '/cloud/dl?u=' + encodeURIComponent(u) + '&h=1';
  };

  window.Cloud = Cloud;
})();
