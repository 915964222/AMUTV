#!/usr/bin/env node
/* 本地公益弹幕反代:设备上 MiniServer 的 gongyiDm 用 gy=http://127.0.0.1:8785 走本代理,
 * 由开发机(网络快)转发到 danmaku-api.152468.xyz —— 用于慢网络环境下的端到端验证,
 * 也演示了「自建 danmu_api 地址」的接入方式。用法: node tools/gy-proxy.js [端口=8785] */
const http = require('http'), https = require('https');
const UP = 'https://danmaku-api.152468.xyz';
const port = Number(process.argv[2] || 8785);
http.createServer((req, res) => {
  const t0 = Date.now();
  const r = https.get(UP + req.url, {
    headers: { 'User-Agent': 'AMUTV/1.4', 'Accept': 'application/json' },
    timeout: 30000,
  }, up => {
    const chunks = [];
    up.on('data', c => chunks.push(c));
    up.on('end', () => {
      const body = Buffer.concat(chunks);
      console.log(`[gy-proxy] ${req.url.slice(0, 70)} -> ${up.statusCode} ${body.length}B ${Date.now() - t0}ms`);
      res.writeHead(up.statusCode, { 'Content-Type': up.headers['content-type'] || 'application/json' });
      res.end(body);
    });
  });
  r.on('timeout', () => { r.destroy(new Error('upstream timeout')); });
  r.on('error', e => {
    console.log(`[gy-proxy] ${req.url.slice(0, 70)} -> ERR ${e.message}`);
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, errorMessage: e.message }));
  });
}).listen(port, '127.0.0.1', () => console.log(`[gy-proxy] listening on 127.0.0.1:${port} -> ${UP}`));
