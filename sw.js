/* 影视TV Service Worker:静态资源离线缓存
 * 代理/接口请求永不缓存(实时数据)。版本号改动即可刷新缓存。
 */
const CACHE = 'tvw-static-v50';
const STATIC = [
  '/', '/index.html', '/css/style.css',
  '/js/store.js', '/js/api.js', '/js/keynav.js', '/js/player.js', '/js/ui.js', '/js/app.js',
  '/ad-rules.js?v=20',  '/js/live.js', '/js/danmaku.js', '/js/subtitle.js', '/vendor/hls.min.js?v=24', '/vendor/pinyin-pro.min.js?v=24',
  '/manifest.json', '/icons/icon.svg',
];
const NEVER = /\/(proxy2?|webdav|alist|api\.php|sniff|dav|d|rc|cloud|remote)\b/;

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(STATIC)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys =>
    Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
  ).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || NEVER.test(url.pathname)) return;
  if (url.origin !== location.origin) return;
  // 导航请求:网络优先,失败回缓存(离线打开UI)
  if (e.request.mode === 'navigate') {
    e.respondWith(fetch(e.request).catch(() => caches.match('/')));
    return;
  }
  // 静态资源:缓存优先,后台更新
  e.respondWith(
    caches.match(e.request).then(hit => {
      const net = fetch(e.request).then(res => {
        if (res.ok) caches.open(CACHE).then(c => c.put(e.request, res.clone()));
        return res;
      }).catch(() => hit);
      return hit || net;
    })
  );
});
