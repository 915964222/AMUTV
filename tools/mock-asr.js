/* ============================================================
 * mock ASR:本地假识别服务,用来验证「录音 → 上传 → 解析 → 执行」整条链路,
 * 不需要真的 API Key,也不依赖外网。
 *
 * 用法(PC 上跑,再让设备通过 adb reverse 访问):
 *   node tools/mock-asr.js            # 监听 127.0.0.1:9999
 *   adb reverse tcp:9999 tcp:9999     # 设备上的 127.0.0.1:9999 → 这台电脑
 *   # App 里「识别服务」填 http://127.0.0.1:9999/asr
 *
 * 环境变量:
 *   PORT  监听端口(默认 9999)
 *   TEXT  固定返回的识别文本(默认「看庆余年」)
 * ============================================================ */
const http = require('http');

const PORT = Number(process.env.PORT || 9999);
const TEXT = process.env.ASR_TEXT || '看庆余年';

function cors() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS'
  };
}

http.createServer((req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors());
    return res.end();
  }
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    const ct = String(req.headers['content-type'] || '');
    const multipart = /multipart\/form-data/i.test(ct);
    const riff = body.indexOf(Buffer.from('RIFF')) >= 0;
    console.log(
      '[mock-asr] ' + req.method + ' ' + req.url +
      ' ' + body.length + 'B multipart=' + multipart + ' RIFF=' + riff
    );
    const out = {
      text: TEXT,
      echo: { bytes: body.length, multipart, riff }
    };
    res.writeHead(200, Object.assign({ 'Content-Type': 'application/json' }, cors()));
    res.end(JSON.stringify(out));
  });
}).listen(PORT, '127.0.0.1', () => {
  console.log('[mock-asr] http://127.0.0.1:' + PORT + '/asr  固定返回: ' + TEXT);
});
