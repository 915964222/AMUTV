# -*- coding: utf-8 -*-
import io

p = r'C:\Users\91596\.zcode\workspace\17e4ecba-c7c4-40ce-b117-87a9e9f578b3\tvbox-web\server.js'
s = io.open(p, encoding='utf-8').read()

anchor = "/* ---------- WebDAV 目录列表 ----------"
assert anchor in s, 'anchor missing'

nas = r'''/* ---------- 局域网挂载(SMB/本地路径):Windows UNC 与本地盘统一用 fs 直读 ----------
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
  sendFileWithRange(res, p, req.headers.range);
}

function handleTsList(req, res, u) {
  const target = u.searchParams.get('u');
  if (!target) { res.writeHead(400); return res.end('missing ?u='); }
  res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' });
  res.end(['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-PLAYLIST-TYPE:VOD', '#EXT-X-TARGETDURATION:30',
    '#EXTINF:30.0,', target, '#EXT-X-ENDLIST'].join('\n'));
}

''' + anchor

s = s.replace(anchor, nas)
io.open(p, 'w', encoding='utf-8').write(s)
print('nas functions added')
