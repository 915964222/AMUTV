const AF = require('../ad-rules.js');
const B = 'https://cdn.ffzy.com/hls/20260101/abcd/index.m3u8';
let pass = 0, fail = 0;
function t(name, cond, extra) { if (cond) { pass++; console.log('  PASS ' + name); } else { fail++; console.log('  FAIL ' + name + (extra ? ' :: ' + extra : '')); } }

console.log('[1] URL 规则层');
[['/ad/x.ts', true], ['ads/a.ts', true], ['/guanggao/1.ts', true], ['/adjump/time/1.ts', true],
 ['/bet365/1.ts', true], ['casino.ts', true], ['六合彩.ts', true], ['phish.ts', true],
 ['/hls/20260101/abcd/0001.ts', false], ['/video/bettery.ts', false], ['/live/channel01/index.m3u8', false]]
 .forEach(([u, want]) => t(u + ' -> ' + want, AF.isAdUrl(u) === want, 'got ' + AF.isAdUrl(u)));

console.log('[2] CUE 区间');
const cue = ['#EXTM3U','#EXT-X-TARGETDURATION:6','#EXTINF:6,','a/1.ts','#EXT-X-CUE-OUT:30','#EXTINF:6,','ad1.ts','#EXTINF:6,','ad2.ts','#EXT-X-CUE-IN','#EXTINF:6,','a/2.ts','#EXT-X-ENDLIST'].join('\n');
let r = AF.filterM3U8(cue, B);
t('CUE 区间整段剔除', r.removed === 2 && !/ad1|ad2/.test(r.text) && /a\/1\.ts/.test(r.text) && /a\/2\.ts/.test(r.text), 'removed=' + r.removed);

console.log('[3] DISCONTINUITY 广告块');
const dis = ['#EXTM3U','#EXT-X-TARGETDURATION:6','#EXTINF:6,','v/1.ts','#EXT-X-DISCONTINUITY','#EXTINF:6,','https://other.com/ads/x1.ts','#EXTINF:6,','https://other.com/ads/x2.ts','#EXT-X-DISCONTINUITY','#EXTINF:6,','v/2.ts','#EXT-X-ENDLIST'].join('\n');
r = AF.filterM3U8(dis, B);
t('广告块剔除且保留后续正片', r.removed === 2 && !/ads\/x1/.test(r.text) && /v\/2\.ts/.test(r.text), 'removed=' + r.removed);
const disOk = ['#EXTM3U','#EXT-X-TARGETDURATION:6','#EXTINF:6,','v/1.ts','#EXT-X-DISCONTINUITY','#EXTINF:6,','v/2.ts','#EXT-X-ENDLIST'].join('\n');
r = AF.filterM3U8(disOk, B);
t('无广告的 DISCONTINUITY 不误杀', r.removed === 0 && /v\/2\.ts/.test(r.text), 'removed=' + r.removed);

console.log('[4] 结构层(少数派目录)');
const segs = [];
for (let i = 0; i < 30; i++) segs.push('#EXTINF:6,', 'https://cdn.ffzy.com/hls/20260101/abcd/' + String(i).padStart(4,'0') + '.ts');
segs.splice(21, 0, '#EXTINF:6,', 'https://cdn.ffzy.com/video/adjump/time/9.ts');
const st = ['#EXTM3U','#EXT-X-TARGETDURATION:6'].concat(segs, ['#EXT-X-ENDLIST']).join('\n');
r = AF.filterM3U8(st, B);
t('少数派目录整组剔除', r.removed === 1 && !/adjump/.test(r.text), 'removed=' + r.removed);
const multi = [];
for (let i = 0; i < 20; i++) multi.push('#EXTINF:6,', (i % 2 ? 'https://cdn-a.com/x/' : 'https://cdn-b.com/x/') + i + '.ts');
r = AF.filterM3U8(['#EXTM3U'].concat(multi, ['#EXT-X-ENDLIST']).join('\n'), B);
t('双 CDN 轮转不误杀', r.removed === 0, 'removed=' + r.removed);

console.log('[5] 边界');
t('master playlist 不做结构判断', AF.filterM3U8('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000\n1080/index.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=400000\n720/index.m3u8', B).removed === 0);
t('非 m3u8 文本原样返回', AF.filterM3U8('hello', B).text === 'hello');
t('切片太少不做结构判断', AF.filterM3U8(['#EXTM3U','#EXTINF:6,','a/1.ts','#EXTINF:6,','https://o.com/z/2.ts'].join('\n'), B).removed === 0);

console.log('[6] 相对路径切片(采集站常见写法)');
const rel = ['#EXTM3U', '#EXTINF:6,', 'v/1.ts', '#EXTINF:6,', 'gg/promo.ts', '#EXTINF:6,', 'AD/ad.mp4', '#EXTINF:6,', 'v/2.ts', '#EXT-X-ENDLIST'].join('\n');
r = AF.filterM3U8(rel, 'https://cdn.ffzy.com/hls/x/index.m3u8');
t('相对路径 gg/ 与 AD/ 被识别', r.removed === 2 && !/gg\/promo|AD\/ad/.test(r.text) && /v\/1\.ts/.test(r.text) && /v\/2\.ts/.test(r.text), 'removed=' + r.removed);
r = AF.filterM3U8(['#EXTM3U', '#EXTINF:6,', 'v/1.ts', '#EXTINF:6,', 'v/2.ts', '#EXT-X-ENDLIST'].join('\n'), 'https://cdn.ffzy.com/hls/x/index.m3u8');
t('相对路径正片不误杀', r.removed === 0, 'removed=' + r.removed);

console.log('\n结果: ' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
