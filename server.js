/* 影视TV Web · 本地服务器
 * 用法: node server.js  (默认 http://localhost:9978)
 * 功能: 1) 托管静态页面  2) /proxy?u= 跨域/防盗链代理
 * 代理特性: HTTPS 优先 HTTP/2(绕过部分 CDN 对 HTTP/1.1 指纹的拦截),
 *          干净请求头、服务端跟随重定向、支持 Range 视频拖动。
 */
const http = require('http');
const https = require('https');
const http2 = require('http2');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const AdFilter = require('./ad-rules.js');

const PORT = process.env.PORT || 9978;
const ROOT = __dirname;
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.mp4': 'video/mp4', '.m3u8': 'application/vnd.apple.mpegurl', '.ts': 'video/mp2t', '.m2ts': 'video/mp2t', '.mts': 'video/mp2t',
};

/* ---------- 上游请求:HTTP/2 优先,HTTP/1.1 兜底 ---------- */
const h2Sessions = new Map();
function getH2Session(origin) {
  const old = h2Sessions.get(origin);
  if (old && !old.closed && !old.destroyed) return old;
  const s = http2.connect(origin);
  h2Sessions.set(origin, s);
  s.on('error', () => { if (h2Sessions.get(origin) === s) h2Sessions.delete(origin); });
  s.on('close', () => { if (h2Sessions.get(origin) === s) h2Sessions.delete(origin); });
  return s;
}

function cleanHeaders(range) {
  // 注意:不要伪装浏览器 UA —— 部分站点(Cloudflare)校验 UA 与 TLS 指纹一致性,
  // Node 指纹 + 浏览器 UA 会被 403;不发送 UA 反而畅通。
  const h = { 'accept': '*/*', 'accept-encoding': 'identity' };
  if (range) h.range = range;
  return h;
}

function withAuth(headers, auth) {
  // auth: 'user:pass' 明文,此处转 Basic
  if (auth) headers.authorization = 'Basic ' + Buffer.from(auth).toString('base64');
  return headers;
}

function requestUpstream(target, range, auth, extraHeaders) {
  return new Promise((resolve, reject) => {
    const u = new URL(target);
    const viaHttp1 = (res) => {
      const mod = u.protocol === 'http:' ? http : https;
      const h = withAuth(cleanHeaders(range), auth);
      if (extraHeaders) Object.assign(h, extraHeaders);
      const r = mod.request(u, { headers: h, timeout: 30000 }, res2 => {
        resolve({ status: res2.statusCode, headers: res2.headers, stream: res2, proto: 'h1' });
      });
      r.on('timeout', () => r.destroy(new Error('upstream timeout')));
      r.on('error', reject);
      r.end();
    };

    if (u.protocol !== 'https:') return viaHttp1();

    let session;
    try { session = getH2Session(u.origin); } catch { return viaHttp1(); }

    let settled = false;
    let stream;
    const reqT0 = Date.now();
    try {
      const h = withAuth(cleanHeaders(range), auth);
      if (extraHeaders) Object.assign(h, extraHeaders);
      // 自定义头(如 Alist token)可能导致与连接复用上下文冲突,直接走 http1 保证可靠
      if (extraHeaders) return viaHttp1();
      stream = session.request({
        ':method': 'GET', ':path': u.pathname + u.search,
        ...h,
      });
    } catch { return viaHttp1(); }

    stream.setTimeout(30000, () => {
      try { stream.close(); } catch {}
      if (!settled) { settled = true; viaHttp1(); }
    });
    stream.on('error', () => {
      if (!settled) { settled = true; viaHttp1(); }
    });
    stream.on('response', headers => {
      if (settled) return;
      settled = true;
      resolve({ status: headers[':status'], headers, stream, proto: 'h2', t0: reqT0 });
    });
    stream.end();
  });
}

/* ---------- /proxy 处理 ----------
 * 两种形式:/proxy?u=<url>  或  /proxy/<url>(路径式,m3u8 相对分段可正确回代理)
 * /sniff/<url>:嗅探模式,HTML 剥离安全头并注入嗅探钩子
 * 可选参数:a=<base64 user:pass>(Basic 认证)、h=<encodeURIComponent('头: 值')>(自定义头)
 */
function parseProxyTarget(req, u) {
  for (const prefix of ['/proxy/', '/proxy2/', '/sniff/', '/sniff2/']) {
    if (u.pathname.startsWith(prefix)) {
      let t = u.pathname.slice(prefix.length);
      try { t = decodeURIComponent(t); } catch {}
      if (u.search) {
        // 拼回目标自身 query,但剥离代理专属参数(h=自定义头/a=认证),否则会被当成目标参数污染上游请求
        const sp = new URLSearchParams(u.search);
        sp.delete('h'); sp.delete('a');
        const rest = sp.toString();
        if (rest) t += (t.indexOf('?') > -1 ? '&' : '?') + rest;
      }
      return t;
    }
  }
  if (['/proxy', '/proxy/', '/proxy2', '/proxy2/', '/sniff', '/sniff/', '/sniff2'].includes(u.pathname)) {
    return u.searchParams.get('u');
  }
  return null;
}

/* ---------- m3u8 相对地址重写 ----------
 * 直播/点播列表里的相对分段(如 /gc/xx.ts 或 seg.ts)经路径式代理会被解析到
 * 本站根路径而丢掉上游主机。这里把所有 URI 行改写成完整代理链:
 *   绝对 http(s) → /proxy/<url>
 *   根相对 /x    → /proxy/<上游origin>/x
 *   纯相对 x.ts  → /proxy/<列表所在目录>/x.ts
 * 同时处理 #EXT-X-KEY / #EXT-X-MAP / #EXT-X-MEDIA 的 URI="..." 属性。
 */
function rewriteM3U8Urls(text, playlistUrl) {
  let base;
  try { base = new URL(playlistUrl); } catch (e) { return text; }
  const proxyAbs = function (abs) { return '/proxy/' + abs; };
  const mapUri = function (u) {
    try {
      if (/^https?:\/\//i.test(u)) return proxyAbs(new URL(u, base).href);
      const abs = new URL(u, base).href;          // 相对→绝对(处理 /x 与 x 两种)
      return proxyAbs(abs);
    } catch (e) { return u; }
  };
  return text.split(/\r?\n/).map(function (line) {
    if (!line) return line;
    if (line.charAt(0) === '#') {
      // URI="..." 属性(KEY/MAP/MEDIA/SESSION-KEY 等)
      return line.replace(/URI="([^"]+)"/g, function (m, u) { return 'URI="' + mapUri(u) + '"'; });
    }
    if (/^https?:\/\//i.test(line)) return proxyAbs(line);
    return mapUri(line.trim());
  }).join('\n');
}

function handleProxy(req, res, u) {
  let target = parseProxyTarget(req, u);
  if (!target) target = u.searchParams.get('u');
  target = (target || '').split('#')[0];
  const sniffMode = u.pathname.startsWith('/sniff/');
  if (!target || !/^https?:\/\//i.test(target)) {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('proxy: missing or invalid ?u= url');
  }
  let hops = 0;
  const go = () => {
    const auth = u.searchParams.get('a') ? Buffer.from(u.searchParams.get('a'), 'base64').toString('utf8') : null;
    const rawHeaders = u.searchParams.getAll('h'); // 自定义头:'Name: value'(可多条)
    let extra = null;
    if (rawHeaders.length) {
      extra = {};
      rawHeaders.forEach(hv => {
        const idx = hv.indexOf(':');
        if (idx > 0) extra[hv.slice(0, idx).trim()] = hv.slice(idx + 1).trim();
      });
    }
    requestUpstream(target, req.headers.range, auth, extra).then(up => {
      const loc = up.headers.location;
      if (loc && [301, 302, 303, 307, 308].includes(up.status) && hops < 5) {
        up.stream.resume();
        hops++;
        target = new URL(loc, target).href;
        return go();
      }
      console.log('[proxy]', up.proto, req.headers.range || '-', '->', up.status, target.slice(0, 90));
      const ctype = up.headers['content-type'] || '';
      const headers = { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' };
      ['content-type', 'content-length', 'content-range', 'accept-ranges'].forEach(h => {
        if (up.headers[h]) headers[h] = up.headers[h];
      });
      if (!headers['content-type']) headers['content-type'] = 'application/octet-stream';
      if (sniffMode) delete headers['content-security-policy']; // 嗅探:允许同源内嵌

      // M3U8 广告切片过滤 + 相对地址重写(代理层,覆盖所有 HLS 播放路径含原生内核)
      if (!sniffMode && /mpegurl/i.test(ctype)) {
        let m3u8 = '';
        up.stream.setEncoding('utf8');
        up.stream.on('data', c => { m3u8 += c; });
        up.stream.on('end', () => {
          try {
            let out = AdFilter.filterM3U8(m3u8, target).text;
            out = rewriteM3U8Urls(out, target);
            delete headers['content-length'];
            if (!res.headersSent) res.writeHead(up.status, headers);
            res.end(out);
          } catch (e) {
            if (!res.headersSent) res.writeHead(up.status, headers);
            res.end(m3u8);
          }
        });
        up.stream.on('error', () => { try { res.end(); } catch {} });
        res.on('close', () => { try { up.stream.destroy(); } catch {} });
        return;
      }

      if (sniffMode && /text\/html/i.test(ctype)) {
        // 嗅探模式:缓冲 HTML,注入钩子后返回
        let html = '';
        up.stream.setEncoding('utf8');
        up.stream.on('data', c => { html += c; });
        up.stream.on('end', () => {
          const out = transformSniffHtml(html);
          delete headers['content-length'];
          if (!res.headersSent) res.writeHead(up.status, headers);
          res.end(out);
        });
        up.stream.on('error', () => { try { res.end(); } catch {} });
        res.on('close', () => { try { up.stream.destroy(); } catch {} });
        return;
      }
      if (!res.headersSent) res.writeHead(up.status, headers);
      let done = false;
      const finish = () => { if (!done) { done = true; try { res.end(); } catch {} } };
      up.stream.pipe(res);
      // 关键:h2 流/会话中断后必须结束客户端响应,否则 XHR/fetch 永久挂起
      up.stream.on('error', finish);
      up.stream.on('close', () => { if (!res.writableEnded) finish(); });
      res.on('close', () => { try { up.stream.destroy(); } catch {} });
    }).catch(err => {
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
      }
      res.end('proxy error: ' + err.message);
    });
  };
  go();
}

/* ---------- 局域网挂载(SMB/本地路径):Windows UNC 与本地盘统一用 fs 直读 ----------
 * GET /naslist?p=<目录路径>   → 目录列表(JSON)
 * GET /nasfile?p=<文件路径>   → 文件流(支持 Range,4K 大文件可拖动)
 * GET /tslist?u=<已代理的ts/m2ts地址> → 单切片虚拟 m3u8(hls.js 可解 MPEG-TS,用于播放蓝光原盘 .m2ts)
 */
function sendFileWithRange(res, filePath, rangeHeader) {
  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('not found');
    }
    const type = MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
    const base = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' };
    const m = rangeHeader && /bytes=(\d*)-(\d*)/.exec(rangeHeader);
    if (m) {
      let start = m[1] === '' ? NaN : parseInt(m[1], 10);
      let end = m[2] === '' ? stat.size - 1 : parseInt(m[2], 10);
      if (isNaN(start)) { start = Math.max(0, stat.size - parseInt(m[2] || '0', 10)); end = stat.size - 1; }
      end = Math.min(end, stat.size - 1);
      if (isNaN(start) || start > end || start < 0) {
        res.writeHead(416, { 'Content-Range': 'bytes */' + stat.size });
        return res.end();
      }
      res.writeHead(206, Object.assign({}, base, {
        'Content-Range': 'bytes ' + start + '-' + end + '/' + stat.size,
        'Content-Length': end - start + 1,
      }));
      return fs.createReadStream(filePath, { start: start, end: end }).pipe(res);
    }
    res.writeHead(200, Object.assign({}, base, { 'Content-Length': stat.size }));
    fs.createReadStream(filePath).pipe(res);
  });
}

function handleNasList(req, res, u) {
  const p = u.searchParams.get('p') || '';
  fs.readdir(p, { withFileTypes: true }, (err, entries) => {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
    if (err) return res.end(JSON.stringify({ error: '无法访问:' + (err.message || err), list: [] }));
    let pending = entries.length + 1;
    const list = [];
    const done = function () {
      if (--pending) return;
      res.end(JSON.stringify({ error: null, list: list }));
    };
    entries.forEach(function (e) {
      const full = p.replace(/[\\/]+$/, '') + '\\' + e.name;
      if (e.isDirectory()) { list.push({ name: e.name, path: full + '\\', dir: true, size: 0 }); done(); return; }
      fs.stat(full, function (e2, st) {
        if (!e2) list.push({ name: e.name, path: full, dir: false, size: st.size });
        done();
      });
    });
    done();
  });
}

function handleNasFile(req, res, u) {
  const p = u.searchParams.get('p');
  if (!p) { res.writeHead(400); return res.end('missing ?p='); }
  const qr = u.searchParams.get('r'); // 允许把 Range 烘焙进 URL(供虚拟播放列表切片)
  const range = qr ? ('bytes=' + qr) : req.headers.range;
  sendFileWithRange(res, p, range);
}

function handleTsList(req, res, u) {
  // 蓝光原盘 .m2ts/.ts 大文件:按字节范围切成 N 个切片的虚拟 VOD 播放列表,
  // hls.js 分段流式解包,拖动进度=请求对应字节范围,不整文件载入内存
  const p = u.searchParams.get('p');
  const segMB = Math.min(64, Math.max(2, Number(u.searchParams.get('seg')) || 10));
  if (!p) { res.writeHead(400); return res.end('missing ?p='); }
  fs.stat(p, (err, stat) => {
    res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' });
    if (err || !stat.isFile()) return res.end('#EXTM3U\n#EXT-X-ENDLIST');
    const segBytes = segMB * 1048576;
    const n = Math.ceil(stat.size / segBytes);
    const lines = ['#EXTM3U', '#EXT-X-VERSION:4', '#EXT-X-PLAYLIST-TYPE:VOD', '#EXT-X-TARGETDURATION:' + (Math.ceil(segBytes / 1250000) + 5)];
    const base = '/nasfile?p=' + encodeURIComponent(p);
    for (let i = 0; i < n; i++) {
      const start = i * segBytes;
      const end = Math.min(stat.size - 1, start + segBytes - 1);
      lines.push('#EXTINF:' + (segBytes / 2500000).toFixed(3) + ',');
      lines.push(base + '&r=' + start + '-' + end);
    }
    lines.push('#EXT-X-ENDLIST');
    res.end(lines.join('\n'));
  });
}

/* ---------- WebDAV 目录列表 ----------
 * GET /webdav?u=<base>&p=<subdir>&a=<base64(user:pass)>
 * PROPFIND Depth:1,返回 JSON 文件列表
 */
function webdavRequest(method, target, auth, extraHeaders, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(target);
    const headers = { ...cleanHeaders(null), ...extraHeaders };
    if (auth) headers.authorization = 'Basic ' + Buffer.from(auth).toString('base64');
    const mod = u.protocol === 'http:' ? http : https;
    const r = mod.request(u, { method, headers, timeout: 20000 }, res => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', c => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    r.on('timeout', () => r.destroy(new Error('upstream timeout')));
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}

function parseDavXml(xml) {
  const items = [];
  const blocks = xml.split(/<(?:[a-zA-Z0-9]*:)?response[ >]/).slice(1);
  for (const b of blocks) {
    const hrefM = b.match(/<(?:[a-zA-Z0-9]*:)?href>(.*?)<\/(?:[a-zA-Z0-9]*:)?href>/i);
    if (!hrefM) continue;
    let href = hrefM[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
    try { href = decodeURIComponent(href); } catch {}
    const isDir = /<(?:[a-zA-Z0-9]*:)?collection\s*\/?>/.test(b);
    const sizeM = b.match(/<(?:[a-zA-Z0-9]*:)?getcontentlength>(\d+)</i);
    let name = href.replace(/\/+$/, '').split('/').pop();
    try { name = decodeURIComponent(name); } catch {}
    items.push({ name, path: href, dir: isDir || href.endsWith('/'), size: sizeM ? Number(sizeM[1]) : 0 });
  }
  return items;
}

function handleWebdav(req, res, u) {
  const base = u.searchParams.get('u');
  const sub = u.searchParams.get('p') || '/';
  const auth = u.searchParams.get('a') ? Buffer.from(u.searchParams.get('a'), 'base64').toString('utf8') : null;
  if (!base || !/^https?:\/\//i.test(base)) {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('webdav: missing ?u=');
  }
  const target = base.replace(/\/+$/, '') + (sub.startsWith('/') ? sub : '/' + sub);
  const body = '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:displayname/><d:resourcetype/><d:getcontentlength/><d:getlastmodified/></d:prop></d:propfind>';
  webdavRequest('PROPFIND', target, auth, { depth: '1', 'content-type': 'application/xml' }, body).then(r => {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
    if (r.status !== 207) return res.end(JSON.stringify({ error: 'WebDAV 返回 ' + r.status, list: [] }));
    res.end(JSON.stringify({ error: null, list: parseDavXml(r.body) }));
  }).catch(err => {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ error: err.message, list: [] }));
  });
}

/* ---------- 演示网盘:本机 media/ 目录以只读 WebDAV 形式提供 ---------- */
function handleDavDemo(req, res, u) {
  if (req.method === 'PROPFIND') {
    const dir = path.join(ROOT, 'media');
    fs.readdir(dir, (err, files) => {
      if (err) { res.writeHead(404); return res.end(); }
      let pending = files.length + 1;
      const items = [];
      const done = () => {
        if (--pending) return;
        const xml = items.map(it => `<d:response><d:href>${encodeURIComponent(it.name)}${it.dir ? '/' : ''}</d:href><d:propstat><d:prop>${it.dir ? '<d:resourcetype><d:collection/></d:resourcetype>' : '<d:resourcetype/>' + `<d:getcontentlength>${it.size}</d:getcontentlength>`}</d:prop></d:propstat></d:response>`).join('');
        res.writeHead(207, { 'Content-Type': 'application/xml; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
        res.end(`<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">${xml}</d:multistatus>`);
      };
      items.push({ name: '', dir: true, size: 0 });
      files.forEach(f => {
        fs.stat(path.join(dir, f), (e, st) => {
          if (!e) items.push({ name: f, dir: st.isDirectory(), size: st.size });
          done();
        });
      });
      done();
    });
    return;
  }
  // 其他方法按静态文件处理(GET 已支持 Range):/dav/xxx、/d/xxx → /media/xxx
  req.url = req.url.replace(/^\/dav/, '/media').replace(/^\/d\//, '/media/');
  return handleStatic(req, res);
}

/* ---------- Alist 列目录代理 ----------
 * GET /alist?u=<alist地址>&p=<路径>&t=<token>
 * 转发 POST {u}/api/fs/list,统一返回 {error, list:[{name,path,dir,size}]}
 */
function handleAlistProxy(req, res, u) {
  const base = u.searchParams.get('u');
  const p = u.searchParams.get('p') || '/';
  const token = u.searchParams.get('t') || '';
  const reply = (obj) => {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(obj));
  };
  if (!base || !/^https?:\/\//i.test(base)) return reply({ error: 'missing ?u=', list: [] });
  const target = new URL(base.replace(/\/+$/, '') + '/api/fs/list');
  const mod = target.protocol === 'http:' ? http : https;
  const body = JSON.stringify({ path: p, password: '', page: 1, per_page: 0, refresh: false });
  const r = mod.request(target, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body),
      'user-agent': 'Mozilla/5.0',
      ...(token ? { authorization: token } : {}),
    },
    timeout: 20000,
  }, up => {
    let data = '';
    up.setEncoding('utf8');
    up.on('data', c => { data += c; });
    up.on('end', () => {
      try {
        const j = JSON.parse(data);
        if (j.code !== 200 || !j.data) return reply({ error: j.message || ('Alist 返回 ' + j.code), list: [] });
        const base = p.endsWith('/') ? p : p + '/';
        const list = (j.data.content || []).map(f => ({
          name: f.name,
          path: base + f.name + (f.is_dir ? '/' : ''),
          dir: !!f.is_dir,
          size: f.size || 0,
        }));
        reply({ error: null, list });
      } catch (e) { reply({ error: '解析失败:' + e.message, list: [] }); }
    });
  });
  r.on('timeout', () => r.destroy(new Error('upstream timeout')));
  r.on('error', err => reply({ error: err.message, list: [] }));
  r.write(body);
  r.end();
}

/* ---------- 演示CMS站:与内置演示源同片名,用于验证多源搜索/换源 ---------- */
const FAKE_CMS_LIST = [
  { vod_id: 1, vod_name: '大雄兔', vod_pic: 'https://picsum.photos/seed/bunny1/300/450', vod_remarks: 'CMS演示', type_id: 1, type_name: '电影', vod_year: '2024', vod_area: '欧美', vod_class: '电影', vod_actor: '', vod_director: '', vod_content: '本地CMS演示站资源,用于测试多源搜索与换源。', vod_play_from: 'CMS线路', vod_play_url: '第01集$/media/demo.mp4' },
  { vod_id: 2, vod_name: '辛特尔', vod_pic: 'https://picsum.photos/seed/sintel3/300/450', vod_remarks: 'CMS演示', type_id: 1, type_name: '电影', vod_year: '2024', vod_area: '欧美', vod_class: '电影', vod_actor: '', vod_director: '', vod_content: '本地CMS演示站资源。', vod_play_from: 'CMS线路', vod_play_url: '第01集$/media/demo.mp4' },
  { vod_id: 3, vod_name: '狂飙之路', vod_pic: 'https://picsum.photos/seed/bullrun12/300/450', vod_remarks: '第1季', type_id: 2, type_name: '纪录', vod_year: '2024', vod_area: '欧美', vod_class: '纪录', vod_actor: '', vod_director: '', vod_content: '共2集。', vod_play_from: 'CMS线路', vod_play_url: '第01集$/media/demo.mp4#第02集$/media/demo.mp4' },
];
function handleFakeCms(req, res, u) {
  const ac = u.searchParams.get('ac') || 'detail';
  const wd = u.searchParams.get('wd');
  const ids = u.searchParams.get('ids');
  let list = FAKE_CMS_LIST;
  if (wd) list = list.filter(v => v.vod_name.includes(wd));
  if (ids) list = list.filter(v => String(v.vod_id) === String(ids));
  const body = ac === 'list'
    ? { code: 1, class: [{ type_id: 1, type_name: '电影' }, { type_id: 2, type_name: '纪录' }], list: [] }
    : { code: 1, total: list.length, page: 1, pagecount: 1, limit: 20, list };
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

/* ---------- Alist 兼容 API(演示:挂在 /dav 上的 media 目录) ----------
 * 真实 Alist:POST /api/fs/list {path} + Authorization: <token>
 * 演示实现接受任意 token,列出 media/ 目录
 */
function handleAlistDemo(req, res, u) {
  if (req.method !== 'POST' || u.pathname !== '/api/fs/list') return handleStatic(req, res);
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', () => {
    let p = '/';
    try { p = (JSON.parse(body || '{}').path || '/').replace(/\.\./g, ''); } catch {}
    const dir = path.join(ROOT, 'media', p);
    fs.readdir(dir, (err, files) => {
      if (err) {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
        return res.end(JSON.stringify({ code: 500, message: 'not found', data: null }));
      }
      let pending = files.length + 1;
      const content = [];
      const done = () => {
        if (--pending) return;
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ code: 200, message: 'success', data: { content: content.map(f => ({ name: f.name, is_dir: f.dir, size: f.size, type: f.dir ? 1 : 0 })), readme: '', write: false, provider: 'Local' } }));
      };
      files.forEach(f => fs.stat(path.join(dir, f), (e, st) => {
        if (!e) content.push({ name: f, dir: st.isDirectory(), size: st.size });
        done();
      }));
      done();
    });
  });
}

/* ---------- 嗅探转换代理 ----------
 * /sniff/<url>:转发页面,剥离 X-Frame-Options/CSP,HTML 注入媒体嗅探钩子。
 * 相对资源地址自然落回 /sniff/ 前缀,整站经由本地代理(同源,可 postMessage)。
 */
const SNIFF_HOOK = `<script data-tvsniff>(function(){
  var found = {};
  var re = /\\.(m3u8|mp4|mkv|flv|webm|avi|mov|ts)(\\?|#|$)/i;
  function add(u){
    if(!u || typeof u !== 'string' || u.indexOf('data:') === 0 || u.indexOf('blob:') === 0) return;
    if(!re.test(u)) return;
    if(found[u]) return; found[u] = 1;
    try { parent.postMessage({ __tvsniff: 1, url: u, href: location.href }, '*'); } catch(e) {}
  }
  try {
    var of = window.fetch;
    if (of) window.fetch = function(i, o){ try{ add(typeof i === 'string' ? i : (i && i.url) || ''); }catch(e){} return of.apply(this, arguments); };
    var ox = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function(m, u){ try{ add(u); }catch(e){} return ox.apply(this, arguments); };
    var oe = window.Element.prototype.setAttribute;
    window.Element.prototype.setAttribute = function(n, v){ try{ if(/src|href/i.test(n)) add(v); }catch(e){} return oe.apply(this, arguments); };
    new MutationObserver(function(muts){
      muts.forEach(function(m){
        (m.addedNodes || []).forEach(function(n){
          try {
            if (n.tagName === 'VIDEO' || n.tagName === 'SOURCE') add(n.currentSrc || n.src);
            if (n.querySelectorAll) n.querySelectorAll('video,source,a').forEach(function(x){ add(x.currentSrc || x.src || x.href); });
          } catch(e) {}
        });
      });
      try { document.querySelectorAll('video,source').forEach(function(v){ add(v.currentSrc || v.src); }); } catch(e) {}
    }).observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ['src'] });
  } catch(e) {}
  window.__tvsniffed = Object.keys(found);
})();</script>`;

function transformSniffHtml(body) {
  // 剥离安全头由 headers 处理;这里注入钩子到 <head> 或开头
  if (/<head[^>]*>/i.test(body)) return body.replace(/<head[^>]*>/i, m => m + SNIFF_HOOK);
  return SNIFF_HOOK + body;
}

/* ---------- 直链提取:/sniff2/<url> ----------
 * 采集源的 play_url 常是 HTML 分享页(/share/xxx、/play/xxx),
 * 真正的视频地址藏在页面 JS 里(常见:var main = "/2026.../index.m3u8?sign=..")。
 * 服务端抓页面 → 正则抽候选 → 逐个探测是否真媒体 → 返回 JSON 直链。
 * 与 android/MiniServer.java 的同名端点行为一致。
 */
function collectMediaCandidates(html, baseUrl) {
  const out = [];
  const h = String(html || '').replace(/\\\//g, '/').replace(/&amp;/g, '&');
  const push = (raw) => {
    if (!raw) return;
    let s = String(raw).trim();
    if (!s) return;
    if (s.startsWith('//')) s = 'https:' + s;
    else if (!/^https?:\/\//i.test(s)) {
      try { s = new URL(s, baseUrl).href; } catch { return; }
    }
    if (!/\.m3u8(\?|$)/i.test(s) && !/\.mp4(\?|$)/i.test(s)) return;
    if (!out.includes(s)) out.push(s);
  };
  let m;
  const reVar = /(?:main|video_url|videourl|m3u8_url|m3u8url|url|file|src|play_url|playurl|src_url|hls)\s*[:=]\s*["']([^"'<>\s]{6,400})["']/gi;
  while ((m = reVar.exec(h))) push(m[1]);
  const reM3u8 = /["']([^"'<>\s]{0,400}\.m3u8[^"'<>\s]{0,200})["']/gi;
  while ((m = reM3u8.exec(h))) push(m[1]);
  const reMp4 = /["']([^"'<>\s]{0,400}\.mp4[^"'<>\s]{0,120})["']/gi;
  while ((m = reMp4.exec(h))) push(m[1]);
  return out;
}

function probeMedia(url, ref) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(url); } catch { return resolve(false); }
    const mod = u.protocol === 'http:' ? http : https;
    const headers = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124.0', 'accept': '*/*', 'accept-encoding': 'identity', range: 'bytes=0-2047' };
    if (ref) headers.referer = ref;
    const req = mod.request(u, { headers, timeout: 12000 }, (res) => {
      const ct = String(res.headers['content-type'] || '').toLowerCase();
      if (ct.includes('mpegurl') || ct.includes('video/mp4')) { res.resume(); return resolve(true); }
      let buf = '';
      res.on('data', (c) => { buf += c.toString('utf8', 0, 16); if (buf.length > 16) res.destroy(); });
      res.on('end', () => resolve(buf.startsWith('#EXTM3U')));
      res.on('close', () => resolve(buf.startsWith('#EXTM3U')));
      res.on('error', () => resolve(false));
    });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
    req.end();
  });
}

/* 读取 m3u8 头,返回最高分辨率高度(px)。非 m3u8 或读不到返回 0
   注意:很多源写 RESOLUTION=1080x608(宽 1080 高 608),这是伪 1080,
   真实像素高度只有 608(约 480p)。所以只用高度判档位,宽度会骗人。 */
function probeResolution(url, ref) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(url); } catch { return resolve(0); }
    const mod = u.protocol === 'http:' ? http : https;
    const headers = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124.0', 'accept': '*/*' };
    if (ref) headers.referer = ref;
    let done = false;
    const finish = (h) => { if (!done) { done = true; resolve(h); } };
    const req = mod.request(u, { headers, timeout: 10000 }, (res) => {
      let buf = '';
      res.on('data', (c) => {
        buf += c.toString('utf8');
        const re = /RESOLUTION=(\d+)x(\d+)/gi;
        let m, best = 0;
        while ((m = re.exec(buf))) {
          const hh = parseInt(m[2], 10) || 0;   // 只取高度
          if (hh > best) best = hh;
        }
        if (best) { res.destroy(); return finish(best); }
        if (buf.length > 64 * 1024) { res.destroy(); return finish(0); }
      });
      res.on('end', () => {
        const re = /RESOLUTION=(\d+)x(\d+)/gi;
        let m, best = 0;
        while ((m = re.exec(buf))) {
          const hh = parseInt(m[2], 10) || 0;
          if (hh > best) best = hh;
        }
        finish(best);
      });
      res.on('close', () => {
        const re = /RESOLUTION=(\d+)x(\d+)/gi;
        let m, best = 0;
        while ((m = re.exec(buf))) {
          const hh = parseInt(m[2], 10) || 0;
          if (hh > best) best = hh;
        }
        finish(best);
      });
      res.on('error', () => finish(0));
    });
    req.on('timeout', () => { req.destroy(); finish(0); });
    req.on('error', () => finish(0));
    req.end();
  });
}

async function handleSniff2(req, res, u) {
  let target = parseProxyTarget(req, u);
  /* base64url 参数:?b=<base64url> 传目标 URL(避开 %2F 被浏览器丢弃) */
  if (!target) {
    const b = u.searchParams.get('b');
    if (b) {
      try { target = Buffer.from(b, 'base64url').toString('utf8'); } catch { target = ''; }
    }
  }
  if (!target || !/^https?:\/\//i.test(target)) {
    res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
    return res.end(JSON.stringify({ ok: false, error: 'bad url' }));
  }
  const ref = u.searchParams.get('ref') || '';
  try {
    let finalUrl = target;
    let ctype = '';
    let body = '';
    for (let hop = 0; hop < 5; hop++) {
      const up = await requestUpstream(finalUrl, null, null, ref ? { referer: ref } : null);
      const loc = up.headers.location;
      if (loc && [301, 302, 303, 307, 308].includes(up.status) && hop < 4) {
        up.stream.resume();
        try { finalUrl = new URL(loc, finalUrl).href; } catch { break; }
        continue;
      }
      ctype = String(up.headers['content-type'] || '').toLowerCase();
      const chunks = [];
      let size = 0;
      for await (const c of up.stream) { chunks.push(c); size += c.length; if (size > 3 * 1024 * 1024) break; }
      body = Buffer.concat(chunks).toString('utf8');
      break;
    }
    const send = (obj) => {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(obj));
    };
    if (ctype.includes('mpegurl') || ctype.includes('video/mp4') || ctype.includes('x-mpegurl')) {
      const dh = /\.m3u8(\?|$)/i.test(finalUrl) ? await probeResolution(finalUrl, ref) : 0;
      return send({ ok: true, direct: true, urls: [finalUrl], quality: [dh], page: finalUrl });
    }
    const cands = collectMediaCandidates(body, finalUrl);
    const ok = [];
    for (const c of cands) {
      if (ok.length >= 5) break;
      if (await probeMedia(c, ref)) ok.push(c);
    }
    if (!ok.length) return send({ ok: false, error: 'no media url found' });
    /* 分辨率感知排序:1080P 优先,其次 4K/蓝光,最后未知 */
    const scored = await Promise.all(ok.map(async (c) => ({
      url: c,
      h: /\.m3u8(\?|$)/i.test(c) ? await probeResolution(c, ref) : 0
    })));
    scored.sort((a, b) => (b.h || 0) - (a.h || 0));
    return send({
      ok: true,
      urls: scored.map((s) => s.url),
      page: finalUrl,
      quality: scored.map((s) => s.h || 0)
    });
  } catch (e) {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ ok: false, error: String(e && e.message || e) }));
  }
}

/* ---------- 静态文件(支持 Range,媒体可拖动进度条) ---------- */
function handleStatic(req, res) {
  let p = decodeURIComponent((req.url || '/').split('?')[0]);
  if (p === '/') p = '/index.html';
  const file = path.normalize(path.join(ROOT, p));
  if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end('forbidden'); }
  fs.stat(file, (err, stat) => {
    if (err || !stat.isFile()) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('404 Not Found'); }
    const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
    // 本地小应用:禁缓存,保证改版即生效
    const base = { 'Content-Type': type, 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' };
    const range = req.headers.range;
    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range);
      if (m) {
        let start = m[1] === '' ? NaN : parseInt(m[1], 10);
        let end = m[2] === '' ? stat.size - 1 : parseInt(m[2], 10);
        if (isNaN(start)) { // bytes=-N 后缀形式
          start = Math.max(0, stat.size - parseInt(m[2] || '0', 10));
          end = stat.size - 1;
        }
        end = Math.min(end, stat.size - 1);
        if (isNaN(start) || start > end || start < 0) {
          res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
          return res.end();
        }
        res.writeHead(206, {
          ...base,
          'Content-Range': `bytes ${start}-${end}/${stat.size}`,
          'Content-Length': end - start + 1,
          'Accept-Ranges': 'bytes',
        });
        return fs.createReadStream(file, { start, end }).pipe(res);
      }
    }
    res.writeHead(200, {
      ...base,
      'Content-Length': stat.size,
      'Accept-Ranges': 'bytes',
    });
    fs.createReadStream(file).pipe(res);
  });
}

/* ================= 局域网 Web 遥控 =================
 * 电视端播放器 POST /rc/state 上报播放状态;手机打开 /remote 轮询状态并发命令。
 * 命令经 /rc/cmd 入队,电视端 /rc/poll 拉取执行(纯 HTTP 轮询,兼容 WebView,无 WebSocket)。
 */
const rc = { state: null, cmds: [], seq: 0 };

function readPostBody(req) {
  return new Promise(ok => { let d = ''; req.on('data', c => { d += c; if (d.length > 1e6) req.destroy(); }); req.on('end', () => ok(d)); });
}

async function handleRc(req, res, u) {
  const p = u.pathname;
  if (p === '/rc/state' && req.method === 'POST') {
    try { rc.state = JSON.parse(await readPostBody(req)); } catch (e) { /* 忽略坏包 */ }
    return jout(res, 200, { ok: true });
  }
  if (p === '/rc/state') return jout(res, 200, rc.state || { ended: true });
  if (p === '/rc/cmd' && req.method === 'POST') {
    try {
      const c = JSON.parse(await readPostBody(req));
      if (c && c.type) {
        rc.cmds.push({ id: ++rc.seq, type: c.type, arg: c.arg });
        if (rc.cmds.length > 60) rc.cmds = rc.cmds.slice(-60);
      }
    } catch (e) {}
    return jout(res, 200, { ok: true });
  }
  if (p === '/rc/poll') {
    const since = Number(u.searchParams.get('since')) || 0;
    return jout(res, 200, { cmds: rc.cmds.filter(c => c.id > since), seq: rc.seq });
  }
  if (p === '/rc/info') {
    /* 给手机端的局域网地址(取非内部回环的 IPv4) */
    let lan = 'localhost';
    try {
      const os = require('os');
      const ifs = os.networkInterfaces();
      outer: for (const name of Object.keys(ifs)) {
        for (const it of ifs[name]) {
          if (it.family === 'IPv4' && !it.internal) { lan = it.address; break outer; }
        }
      }
    } catch (e) {}
    return jout(res, 200, { url: `http://${lan}:${PORT}/remote` });
  }
  return jout(res, 404, { error: 'unknown rc route' });
}

/* ================= 弹幕接口代理 =================
 * 三条来源,按优先级自动选(设置里留空即用内置):
 *   1) 自定义模板 tpl:{fileName} 占位,GET 回 B站 XML 或 dandanplay JSON
 *   2) 弹弹play 官方:填了 AppId/AppSecret 才走,按时长+集数匹配最准
 *   3) B站内置(免凭证):搜「片名 + 集数」→ bvid → cid → 弹幕 XML,
 *      拿到实际片长时按片长校正,避免抓成合集/解说视频的弹幕
 * 返回 { xml, from, matched, count };拿不到时 { error }
 */
const DM_DEFAULT = { base: 'https://api.dandanplay.net' };

/* ---- B站:免凭证取弹幕 ----
 * 2026-10 实测:search/type 不带 wbi 签名直接 412 风控;带 buvid3 + w_rid 就正常。
 * nav 未登录(code -101)一样会回 wbi_img,所以不需要任何账号或 AppId。 */
const BILI_TAB = [46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52];
const BILI_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
let biliSess = { cookie: '', mixin: '', at: 0 };

async function biliHttp(url, extra) {
  const hdr = Object.assign({ 'User-Agent': BILI_UA, 'Referer': 'https://www.bilibili.com/' }, extra || {});
  if (biliSess.cookie) hdr.Cookie = biliSess.cookie;
  const r = await fetch(url, { headers: hdr });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) {}
  return { status: r.status, json: json, text: text };
}

async function biliPrep(force) {
  if (!force && biliSess.mixin && Date.now() - biliSess.at < 30 * 60 * 1000) return;
  const spi = await biliHttp('https://api.bilibili.com/x/frontend/finger/spi');
  const b3 = spi.json && spi.json.data && spi.json.data.b_3;
  if (b3) biliSess.cookie = 'buvid3=' + b3 + '; b_nut=' + Math.floor(Date.now() / 1000);
  const nav = await biliHttp('https://api.bilibili.com/x/web-interface/nav');
  const img = nav.json && nav.json.data && nav.json.data.wbi_img;
  if (!img) throw new Error('B站 wbi 密钥获取失败(HTTP ' + nav.status + ')');
  const pick = u => String(u).split('/').pop().split('.')[0];
  const raw = pick(img.img_url) + pick(img.sub_url);
  biliSess.mixin = BILI_TAB.map(i => raw[i]).join('').slice(0, 32);
  biliSess.at = Date.now();
}

function biliSigned(params) {
  const p = Object.assign({}, params, { wts: Math.floor(Date.now() / 1000) });
  const q = Object.keys(p).sort()
    .map(k => encodeURIComponent(k) + '=' + encodeURIComponent(String(p[k]).replace(/[!'()*]/g, '')))
    .join('&');
  return q + '&w_rid=' + require('crypto').createHash('md5').update(q + biliSess.mixin).digest('hex');
}

/* 搜索。412 = 风控,换一次指纹重试 */
async function biliSearch(kw, retried) {
  const r = await biliHttp('https://api.bilibili.com/x/web-interface/wbi/search/type?' + biliSigned({ search_type: 'video', keyword: kw, page: 1 }));
  const blocked = r.status === 412 || (r.json && (r.json.code === -412 || r.json.code === -403));
  if (blocked && !retried) { await biliPrep(true); return biliSearch(kw, true); }
  if (!r.json || !r.json.data || !Array.isArray(r.json.data.result)) return [];
  return r.json.data.result;
}

function biliDurSec(d) {
  const a = String(d || '').split(':').map(Number);
  if (!a.length || a.some(x => !isFinite(x))) return 0;
  if (a.length === 3) return a[0] * 3600 + a[1] * 60 + a[2];
  if (a.length === 2) return a[0] * 60 + a[1];
  return a[0] || 0;
}

/* 中文数字 → 整数(只处理「第 X 集」这种小数字:十/十一/二十三/一百零五) */
function cnNum(str) {
  const d = { '零': 0, '一': 1, '二': 2, '两': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9 };
  let n = 0, cur = 0;
  for (const ch of String(str)) {
    if (ch in d) cur = d[ch];
    else if (ch === '十') { n += (cur || 1) * 10; cur = 0; }
    else if (ch === '百') { n += (cur || 1) * 100; cur = 0; }
    else return 0;
  }
  return n + cur;
}

/* 从标题/分P名里取集数:支持「第05集」「第十集」「第 12 话」 */
function epNoOf(text) {
  const t = String(text || '');
  const m1 = t.match(/第\s*0*(\d+)\s*[集话話期]/);
  if (m1) return Number(m1[1]);
  const m2 = t.match(/第\s*([零一二三四五六七八九十百]{1,5})\s*[集话話期]/);
  if (m2) return cnNum(m2[1]);
  return 0;
}

/* 明显不是正片的(解说/合集/音乐/预告):单集候选里直接排除 */
const DM_DENY = /(解说|解析|影评|盘点|混剪|花絮|预告|片花|OST|主题曲|歌曲|音乐|有声|小说|合集|完整版)/i;

/* 片长是否接近 */
function durClose(a, b, tol) {
  if (!a || !b) return false;
  return Math.abs(a - b) / Math.max(a, b) <= (tol || 0.35);
}

/* 从候选里挑出「到底哪一集」:
 * - 合集(分P):一集一个 P,优先按集数取 P,其次按时长挑 P
 * - 单集上传:标题里写明了别的集数就直接跳过,再按时长收敛
 * 这一步必须看 view 的 pages,只看搜索结果时长会被「整部合集」骗到 */
async function biliPickEpisode(cands, targetDur, epNo) {
  let best = null;
  for (let i = 0; i < cands.length && i < 6; i++) {
    const it = cands[i];
    const title = String(it.title || '').replace(/<[^>]+>/g, '');
    const titleEp = epNoOf(title);
    let v;
    try { v = await biliHttp('https://api.bilibili.com/x/web-interface/view?bvid=' + it.bvid); } catch (e) { continue; }
    const data = v.json && v.json.data;
    if (!data || !data.cid) continue;
    const pages = data.pages || [];
    let page = null, sc = 0;
    if (pages.length > 1) {
      /* 分P合集:一集一个 P。先认 P 名里的集数,再按片长挑 */
      let p = null;
      if (epNo > 0) {
        for (let k = 0; k < pages.length; k++) { if (epNoOf(pages[k].part) === epNo) { p = pages[k]; break; } }
        if (!p && pages[epNo - 1]) p = pages[epNo - 1];
      }
      if (!p && targetDur > 0) {
        let bd = -1;
        for (let k = 0; k < pages.length; k++) {
          const diff = Math.abs(pages[k].duration - targetDur);
          if (bd < 0 || diff < bd) { bd = diff; p = pages[k]; }
        }
      }
      if (!p) continue;
      if (targetDur > 0 && !durClose(p.duration, targetDur, 0.15)) continue;
      page = p;
      sc = 2 + (targetDur > 0 ? (1 - Math.abs(p.duration - targetDur) / targetDur) : 0.5);
      if (epNo > 0 && epNoOf(p.part) === epNo) sc += 1;
    } else {
      /* 单集上传:标题必须写明集数、且跟当前集一致;时长 15% 内;排除解说/合集类 */
      if (epNo > 0 && titleEp !== epNo) continue;
      if (DM_DENY.test(title)) continue;
      if (targetDur > 0 && !durClose(data.duration, targetDur, 0.15)) continue;
      page = { cid: data.cid, page: 1, part: '' };
      sc = 2 + (targetDur > 0 ? (1 - Math.abs(data.duration - targetDur) / targetDur) : 0.3) + (epNo > 0 && titleEp === epNo ? 1.2 : 0);
    }
    if (!best || sc > best.sc) best = { sc: sc, it: it, page: page, title: title, dur: page.duration || data.duration || 0 };
  }
  return best;
}

async function biliFetch(name, ep, duration) {
  await biliPrep();
  const epNo = epNoOf(ep);
  const kws = [];
  if (ep && /第\s*\d+\s*[集话話期]/.test(ep)) kws.push((name + ' ' + ep).trim());
  if (epNo) kws.push(name + ' 第' + epNo + '集');
  kws.push(name);
  /* 每个关键词都搜一遍,凑够候选再统一排序(单关键词经常只回合集/解说) */
  const cands = [], seen = {};
  for (let i = 0; i < kws.length; i++) {
    const kw = kws[i];
    if (!kw) continue;
    const list = await biliSearch(kw, false);
    for (let k = 0; k < list.length; k++) {
      const it = list[k] || {};
      if (!it.bvid || seen[it.bvid]) continue;
      seen[it.bvid] = 1;
      cands.push(it);
    }
    if (cands.length >= 12) break;
  }
  if (!cands.length) return null;
  /* 排序:标题带本集集数 > 时长接近 > 播放量 */
  const epRe = epNo > 0 ? new RegExp('第\\s*(0*' + epNo + '|[零一二三四五六七八九十百]+)\\s*[集话話期]') : null;
  cands.sort(function (a, b) {
    const ta = epRe && epRe.test(String(a.title || '')) ? 1 : 0;
    const tb = epRe && epRe.test(String(b.title || '')) ? 1 : 0;
    if (tb !== ta) return tb - ta;
    if (duration > 0) {
      const fa = Math.abs(biliDurSec(a.duration) - duration) / duration;
      const fb = Math.abs(biliDurSec(b.duration) - duration) / duration;
      if (Math.abs(fa - fb) > 0.2) return fa - fb;
    }
    return Number(b.play || 0) - Number(a.play || 0);
  });
  const best = await biliPickEpisode(cands, duration, epNo);
  if (!best) return null;
  const dmRes = await fetch('https://api.bilibili.com/x/v1/dm/list.so?oid=' + best.page.cid, {
    headers: { 'User-Agent': BILI_UA, 'Referer': 'https://www.bilibili.com/', 'Cookie': biliSess.cookie },
  });
  /* fetch 会自动解掉 content-encoding: deflate,直接拿到的就是 XML */
  const xml = Buffer.from(await dmRes.arrayBuffer()).toString('utf8');
  const count = (xml.match(/<d p=/g) || []).length;
  if (!count) return null;
  const tag = best.page.page > 1 ? (' · P' + best.page.page) : '';
  const mins = Math.round((best.page.duration || 0) / 60);
  return { xml: xml, matched: best.title.slice(0, 36) + tag + (mins ? ' · ' + mins + '分' : ''), count: count };
}

/* ---- 弹弹play 官方(需 AppId/AppSecret) ---- */
async function dandanFetch(fileName, body) {
  const base = String(body.base || DM_DEFAULT.base).replace(/\/+$/, '');
  const ts = Math.floor(Date.now() / 1000) + '';
  const crypto = require('crypto');
  const sig = p2 => crypto.createHmac('sha256', body.appSecret).update(body.appId + ts + p2).digest('base64');
  const hdr = p2 => ({
    'Content-Type': 'application/json', 'User-Agent': BILI_UA,
    'X-AppId': body.appId, 'X-Timestamp': ts, 'X-Signature': sig(p2),
  });
  const mp = '/api/v2/match';
  const m = await fetch(base + mp, { method: 'POST', headers: hdr(mp),
    body: JSON.stringify({ fileName: fileName, fileHash: '', fileSize: 0, videoDuration: 0, matchMode: 1 }) });
  const mj = await m.json().catch(() => null);
  if (!m.ok || !mj || !mj.isMatched || !(mj.matches || []).length) throw new Error('弹弹play 未匹配到剧集(' + m.status + ')');
  const ep = mj.matches[0];
  const cp = '/api/v2/comment/' + ep.episodeId + '?withRelated=true&chConvert=1';
  const c = await fetch(base + cp, { headers: hdr(cp) });
  const cj = await c.json().catch(() => null);
  if (!c.ok || !cj || !Array.isArray(cj.comments)) throw new Error('弹弹play 弹幕拉取失败(' + c.status + ')');
  const xml = '<?xml version="1.0"?><i>' + cj.comments.map(x =>
    '<d p="' + (x.shift || 0) + ',1,25,16777215,' + Math.floor((x.shift || 0) * 1000) + ',0,0,0">' +
    String(x.p || x.text || '').replace(/&/g, '&amp;').replace(/</g, '&lt;') + '</d>').join('') + '</i>';
  return { xml: xml.slice(0, 3e6), matched: ep.episodeTitle || '', count: cj.comments.length };
}

async function handleDm(req, res, u) {
  try {
    if (u.pathname !== '/dm/fetch' || req.method !== 'POST') return jout(res, 404, { error: 'unknown dm route' });
    const body = JSON.parse(await readPostBody(req) || '{}');
    const fileName = String(body.fileName || '').slice(0, 200);
    const name = String(body.name || '').trim().slice(0, 80);
    const ep = String(body.ep || '').trim().slice(0, 60);
    const duration = Math.max(0, Number(body.duration) || 0);
    if (!fileName && !name) return jout(res, 200, { error: '缺少片名' });

    /* 1) 自定义模板接口({fileName} 占位 → B站 XML / dandanplay JSON) */
    if (body.tpl && /^https?:\/\//.test(body.tpl)) {
      const url = body.tpl.replace(/\{fileName\}|\{filename\}/g, encodeURIComponent(fileName || name));
      const r = await fetch(url, { headers: { 'User-Agent': BILI_UA, 'Accept': '*/*' } });
      let xml = await r.text();
      if (!r.ok) return jout(res, 502, { error: '接口返回 ' + r.status });
      let count = 0;
      try {
        const j = JSON.parse(xml);
        if (j && Array.isArray(j.comments)) {
          count = j.comments.length;
          xml = '<?xml version="1.0"?><i>' + j.comments.map(c =>
            '<d p="' + (c.shift || c.time || 0) + ',1,25,16777215,' + Math.floor((c.shift || 0) * 1000) + ',0,0,0">' +
            String(c.text || '').replace(/&/g, '&amp;').replace(/</g, '&lt;') + '</d>').join('') + '</i>';
        }
      } catch (e) {}
      if (!count) count = (xml.match(/<d p=/g) || []).length;
      return jout(res, 200, { xml: xml.slice(0, 3e6), from: 'tpl', count: count });
    }

    /* 2) 弹弹play 官方(填了凭证才走) */
    if (body.appId && body.appSecret) {
      try {
        const r = await dandanFetch(fileName || (name + ' ' + ep).trim(), body);
        return jout(res, 200, Object.assign({ from: 'dandanplay' }, r));
      } catch (e) {
        /* 凭证失效/未匹配 → 继续走内置,不直接把错误甩给用户 */
        body._dandanErr = e.message;
      }
    }

    /* 3) B站内置(免凭证) */
    try {
      const r = await biliFetch(name || fileName, ep, duration);
      if (r) return jout(res, 200, { xml: r.xml, from: 'bilibili', matched: r.matched, count: r.count });
      return jout(res, 200, { error: '没找到匹配的弹幕' + (body._dandanErr ? '(' + body._dandanErr + ')' : '(B站没有这一集的上传)') });
    } catch (e) {
      return jout(res, 200, { error: '弹幕获取失败:' + e.message });
    }
  } catch (e) {
    return jout(res, 502, { error: e.message });
  }
}

/* ================= 在线字幕(SubHD)代理 =================
 * 链路(2026-10 实测):带会话Cookie搜 /search/{kw} → /api/sub/prepare-download
 * → /api/sub/down → dlus 直链字幕文件。cookie 会话过期自动重建。
 */
const SUBHD = 'https://subhd.tv';
const subhdJar = { cookie: '', ts: 0 };

async function subhdFetch(path, opt = {}) {
  const h = { 'User-Agent': UA_PC, 'Referer': SUBHD + '/', ...((opt && opt.headers) || {}) };
  if (subhdJar.cookie) h['Cookie'] = subhdJar.cookie;
  const r = await fetch(SUBHD + path, { ...opt, headers: h, redirect: 'follow' });
  /* 维护会话 cookie(简单拼接,subhd 用 cf_cookie/sid) */
  try {
    const raw = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
    raw.forEach(c => {
      const kv = c.split(';')[0];
      const k = kv.split('=')[0];
      if (!kv) return;
      const parts = subhdJar.cookie ? subhdJar.cookie.split(/;\s*/) : [];
      const idx = parts.findIndex(x => x.startsWith(k + '='));
      if (idx >= 0) parts[idx] = kv; else parts.push(kv);
      subhdJar.cookie = parts.filter(Boolean).join('; ');
    });
  } catch (e) {}
  return r;
}

function extractZipSub(buf) {
  try {
    const zlib = require('zlib');
    for (let i = 0; i < buf.length - 30; i++) {
      if (buf[i] !== 0x50 || buf[i + 1] !== 0x4b) continue;           // PK
      if (buf[i + 2] !== 3 || buf[i + 3] !== 4) continue;             // local file header
      const method = buf.readUInt16LE(i + 8);
      const csize = buf.readUInt32LE(i + 18);
      const nlen = buf.readUInt16LE(i + 26), elen = buf.readUInt16LE(i + 28);
      const name = buf.slice(i + 30, i + 30 + nlen).toString('utf-8');
      if (/\.(srt|ass|ssa|vtt)$/i.test(name) && csize > 0) {
        const data = buf.slice(i + 30 + nlen + elen, i + 30 + nlen + elen + csize);
        return Buffer.from(method === 8 ? zlib.inflateRawSync(data) : data);
      }
      i += 29 + nlen + elen + csize;
    }
  } catch (e) {}
  return buf;
}

async function handleSub(req, res, u) {
  const q = u.searchParams;
  try {
    if (u.pathname === '/sub/search') {
      const kw = q.get('kw') || '';
      if (!kw) return jout(res, 200, { list: [] });
      const r = await subhdFetch('/search/' + encodeURIComponent(kw));
      const html = await r.text();
      const list = [];
      /* 每条字幕: /a/{id} 链接文本=版本名,同卡片内影片名与语言标签 */
      const re = /<a[^>]+href=['"]\/a\/([A-Za-z0-9]+)['"][^>]*>([\s\S]{0,200}?)<\/a>/g;
      let m; const seen = {};
      while ((m = re.exec(html)) && list.length < 40) {
        const id = m[1];
        const name = m[2].replace(/<[^>]+>/g, '').trim();
        if (seen[id] || !name || name.length < 3) continue;
        seen[id] = 1;
        /* 语言/格式标签:取该条目附近的文本 */
        const around = html.slice(m.index, m.index + 1600).replace(/<[^>]+>/g, ' ');
        const lang = (around.match(/(简体|繁体|双语|英文|中英|特效)/g) || []).filter((v, i, a) => a.indexOf(v) === i).join('/');
        const fmt = (around.match(/(SRT|ASS|SSA|VTT)/i) || [])[1] || '';
        list.push({ id, name, lang, fmt });
      }
      return jout(res, 200, { list });
    }
    if (u.pathname === '/sub/down') {
      const id = q.get('id') || '';
      const r1 = await subhdFetch('/api/sub/prepare-download', {
        method: 'POST', headers: { 'Content-Type': 'application/json; charset=utf-8', 'X-Requested-With': 'XMLHttpRequest', 'Referer': SUBHD + '/a/' + id, 'Origin': SUBHD },
        body: JSON.stringify({ sid: id }),
      }).then(x => x.json()).catch(() => null);
      if (!r1 || !r1.success) return jout(res, 502, { error: 'prepare失败:' + ((r1 && r1.msg) || '未知') });
      /* 中间页会种下 down_ cookie,跳过会被判"临时页面失效" */
      await subhdFetch('/down/' + id).then(x => x.text()).catch(() => '');
      const r2 = await subhdFetch('/api/sub/down', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest', 'Referer': SUBHD + '/down/' + id, 'Origin': SUBHD },
        body: JSON.stringify({ sid: id }),
      }).then(x => x.json()).catch(() => null);
      if (!r2 || !r2.success || !r2.url) return jout(res, 502, { error: '下载失败:' + ((r2 && r2.msg) || '未知') });
      /* 拉取字幕本体并透传(zip/srt/ass 均按二进制回) */
      const file = await fetch(r2.url, { headers: { 'User-Agent': UA_PC, 'Referer': SUBHD + '/' } });
      let buf = Buffer.from(await file.arrayBuffer());
      /* zip 包:解出第一个字幕条目(STORED/DEFLATE) */
      if (buf.slice(0, 2).toString('binary') === 'PK') {
        buf = extractZipSub(buf);
      }
      const cd = (r2.url.split('.').pop() || 'srt').toLowerCase();
      res.writeHead(file.ok ? 200 : 502, {
        'Content-Type': file.headers.get('content-type') || 'application/octet-stream',
        'X-Sub-Ext': cd,
        'Content-Length': buf.length, 'Access-Control-Allow-Origin': '*',
      });
      return res.end(buf);
    }
    return jout(res, 404, { error: 'unknown sub route' });
  } catch (e) {
    return jout(res, 502, { error: e.message });
  }
}

/* ================= 手机扫码推送配置 =================
 * 电视端设置页弹二维码(指向 /push);手机打开后粘贴配置接口链接推送过来,
 * 电视端轮询 /cfg/get 发现新链接后自动导入源。
 */
let cfgPush = null;

function handleCfgPush(req, res, u) {
  const p = u.pathname;
  if (p === '/cfg/push' && req.method === 'POST') {
    readPostBody(req).then(d => {
      try {
        const j = JSON.parse(d);
        const url = String(j.url || '').trim();
        if (/^https?:\/\//i.test(url)) { cfgPush = { url: url, ts: Date.now() }; return jout(res, 200, { ok: true }); }
        return jout(res, 200, { ok: false, error: '链接需以 http(s):// 开头' });
      } catch (e) { return jout(res, 200, { ok: false, error: 'bad json' }); }
    });
    return;
  }
  if (p === '/cfg/get') {
    const since = Number(u.searchParams.get('ts')) || 0;
    if (cfgPush && cfgPush.ts > since) return jout(res, 200, cfgPush);
    return jout(res, 200, { empty: true });
  }
  return jout(res, 404, { error: 'unknown cfg route' });
}

/* ================= 云盘(阿里云盘扫码 / 夸克Cookie)代理 =================
 * 阿里走 OAuth 二维码(openapi,无自建应用时经公共 OAuth 中转):
 *   qr → {qrCodeUrl,sid}; poll → status/LoginSuccess+authCode; token → refresh_token
 * 夸克走网页 Cookie(drive-pc 接口,验证可达)。
 * 直链播放统一经 /cloud/dl 中转(带 Range),解决跨设备 IP 与跨域限制。
 */
const ALI_OAUTH = 'https://aliyundrive-oauth.messense.me'; // 无自建应用时的公共 OAuth 中转(messense/aliyundrive-webdav)
const ALI_OPEN = 'https://openapi.aliyundrive.com';
const UA_PC = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

function jout(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

async function cloudFetch(url, opt = {}) {
  const r = await fetch(url, opt);
  const text = await r.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (e) { data = { raw: text.slice(0, 400) }; }
  return { ok: r.ok, status: r.status, data };
}

async function handleCloud(req, res, u) {
  const q = u.searchParams;
  const p = u.pathname;
  try {
    /* ---- 阿里:二维码登录 ---- */
    if (p === '/cloud/ali/qr') {
      const r = await cloudFetch(ALI_OAUTH + '/oauth/authorize/qrcode', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': UA_PC },
        body: JSON.stringify({ scopes: ['user:base', 'file:all:read', 'file:all:write'] }),
      });
      return jout(res, 200, r.data);
    }
    if (p === '/cloud/ali/poll') {
      const sid = q.get('sid') || '';
      const r = await cloudFetch(ALI_OPEN + '/oauth/qrcode/' + sid + '/status', { headers: { 'User-Agent': UA_PC } });
      return jout(res, 200, r.data);
    }
    if (p === '/cloud/ali/token' && req.method === 'POST') {
      const body = await new Promise(ok => { let d = ''; req.on('data', c => d += c); req.on('end', () => ok(d)); });
      const { code } = JSON.parse(body || '{}');
      const r = await cloudFetch(ALI_OAUTH + '/oauth/access_token', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': UA_PC },
        body: JSON.stringify({ grant_type: 'authorization_code', code }),
      });
      return jout(res, 200, r.data);
    }
    /* ---- 阿里:refresh_token → access_token(登录校验/续期) ---- */
    if (p === '/cloud/ali/refresh' && req.method === 'POST') {
      const body = await new Promise(ok => { let d = ''; req.on('data', c => d += c); req.on('end', () => ok(d)); });
      const { refresh_token } = JSON.parse(body || '{}');
      const r = await cloudFetch(ALI_OAUTH + '/oauth/access_token', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': UA_PC },
        body: JSON.stringify({ grant_type: 'refresh_token', refresh_token }),
      });
      return jout(res, 200, r.data);
    }
    /* ---- 阿里:文件列表 / 直链 ---- */
    if (p === '/cloud/ali/list') {
      const r = await cloudFetch(ALI_OPEN + '/adrive/v1.0/openFile/list', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + (q.get('t') || ''), 'User-Agent': UA_PC },
        body: JSON.stringify({ drive_id: q.get('d') || '', parent_file_id: q.get('p') || 'root', limit: 200, order_by: 'type', order_direction: 'ASC' }),
      });
      if (!r.ok) return jout(res, 502, { error: '阿里列表失败:' + JSON.stringify(r.data).slice(0, 200) });
      const list = (r.data.items || []).map(x => ({
        name: x.name, dir: x.type === 'folder', size: x.size || 0, fid: x.file_id,
        drive_id: x.drive_id, url: (x.thumbnail || '').replace('http://', 'https://'),
      }));
      return jout(res, 200, { list, next: r.data.next_page_token || '' });
    }
    if (p === '/cloud/ali/link') {
      const r = await cloudFetch(ALI_OPEN + '/adrive/v1.0/openFile/get', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + (q.get('t') || ''), 'User-Agent': UA_PC },
        body: JSON.stringify({ drive_id: q.get('d') || '', file_id: q.get('fid') || '', expire_sec: 14400 }),
      });
      const url = r.data && r.data.url;
      if (!url) return jout(res, 502, { error: '取直链失败:' + JSON.stringify(r.data).slice(0, 200) });
      return jout(res, 200, { url });
    }
    /* ---- 夸克:文件列表 / 直链(Cookie 登录) ---- */
    if (p === '/cloud/quark/list') {
      const fid = q.get('p') || '0';
      const r = await cloudFetch('https://drive-pc.quark.cn/1/clouddrive/file/sort?pr=ucpro&fr=pc&pdir_fid=' + fid + '&_page=1&_size=200&_fetch_total=1&_fetch_sub_dirs=0&_sort=file_type:asc,file_name:asc', {
        headers: { 'User-Agent': UA_PC, 'Referer': 'https://pan.quark.cn/', 'Cookie': q.get('c') || '' },
      });
      const list = (r.data && r.data.data && r.data.data.list) || [];
      if (r.data && r.data.status && r.data.status !== 200) return jout(res, 502, { error: '夸克列表失败:' + (r.data.message || '') });
      return jout(res, 200, {
        list: list.map(x => ({ name: x.file_name, dir: x.dir, size: x.size || 0, fid: x.fid, url: x.thumbnail || '' })),
      });
    }
    if (p === '/cloud/quark/link') {
      const r = await cloudFetch('https://drive-pc.quark.cn/1/clouddrive/file/download?pr=ucpro&fr=pc&fid=' + (q.get('fid') || ''), {
        method: 'POST', headers: { 'User-Agent': UA_PC, 'Referer': 'https://pan.quark.cn/', 'Content-Type': 'application/json', 'Cookie': q.get('c') || '' },
        body: '{}',
      });
      const d = (r.data && r.data.data) && r.data.data[0];
      if (!d || !d.download_url) return jout(res, 502, { error: '取直链失败:' + JSON.stringify(r.data).slice(0, 200) });
      return jout(res, 200, { url: d.download_url });
    }
    /* ---- 直链流式中转(Range 透传;夸克直链要求浏览器 UA + Referer) ---- */
    if (p === '/cloud/dl') {
      const target = q.get('u') || '';
      const needH = q.get('h') === '1'; // 夸克:带 UA/Referer
      const head = { 'User-Agent': needH ? UA_PC : UA_PC, 'Referer': needH ? 'https://pan.quark.cn/' : '' };
      if (req.headers.range) head['Range'] = req.headers.range;
      const up = await fetch(target, { headers: head, redirect: 'follow' });
      const hh = {
        'Access-Control-Allow-Origin': '*',
        'Content-Type': up.headers.get('content-type') || 'application/octet-stream',
        'Accept-Ranges': 'bytes',
      };
      if (up.headers.get('content-length')) hh['Content-Length'] = up.headers.get('content-length');
      if (up.headers.get('content-range')) hh['Content-Range'] = up.headers.get('content-range');
      res.writeHead(up.status, hh);
      const { Readable } = require('stream');
      const { web } = require('stream');
      Readable.fromWeb(up.body).pipe(res);
      return;
    }
    return jout(res, 404, { error: 'unknown cloud route' });
  } catch (e) {
    return jout(res, 502, { error: e.message });
  }
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url, `http://localhost:${PORT}`);
  if (u.pathname.startsWith('/cloud/')) return handleCloud(req, res, u);
  if (u.pathname.startsWith('/rc/')) return handleRc(req, res, u);
  if (u.pathname.startsWith('/cfg/')) return handleCfgPush(req, res, u);
  if (u.pathname.startsWith('/sub/')) return handleSub(req, res, u);
  if (u.pathname.startsWith('/dm/')) return handleDm(req, res, u);
  if (u.pathname === '/push' || u.pathname === '/push/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return fs.createReadStream(path.join(ROOT, 'push.html')).pipe(res);
  }
  if (u.pathname === '/remote' || u.pathname === '/remote/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return fs.createReadStream(path.join(ROOT, 'remote.html')).pipe(res);
  }
  if (u.pathname === '/sniff2' || u.pathname.startsWith('/sniff2/')) return handleSniff2(req, res, u);
  if (u.pathname === '/proxy' || u.pathname.startsWith('/proxy/') || u.pathname === '/proxy2' || u.pathname.startsWith('/proxy2/') || u.pathname.startsWith('/sniff/')) return handleProxy(req, res, u);
  if (u.pathname === '/webdav') return handleWebdav(req, res, u);
  if (u.pathname === '/alist') return handleAlistProxy(req, res, u);
  if (u.pathname === '/naslist') return handleNasList(req, res, u);
  if (u.pathname === '/nasfile') return handleNasFile(req, res, u);
  if (u.pathname === '/tslist') return handleTsList(req, res, u);
  if (u.pathname.startsWith('/dav') || u.pathname === '/d' || u.pathname.startsWith('/d/')) return handleDavDemo(req, res, u);
  if (u.pathname === '/api/fs/list') return handleAlistDemo(req, res, u);
  if (u.pathname === '/api.php/provide/vod/') return handleFakeCms(req, res, u);
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    });
    return res.end();
  }
  handleStatic(req, res);
});

server.on('error', err => {
  if (err.code === 'EADDRINUSE') {
    console.log(`  ⚠ 端口 ${PORT} 已被占用 —— 可能已有影视TV实例在运行,本进程直接复用它`);
  } else {
    console.log('  ✖ 服务器错误:', err.message);
    process.exit(1);
  }
});

server.listen(PORT, () => {
  console.log('');
  console.log('  📺 影视TV Web 已启动');
  console.log(`  ➜  本机访问:  http://localhost:${PORT}`);
  console.log(`  ➜  局域网访问: http://<本机IP>:${PORT}   (电视/手机同网即可打开)`);
  console.log('  按 Ctrl+C 停止');
  console.log('');
});
