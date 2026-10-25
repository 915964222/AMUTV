/* ================= 数据源适配层 =================
 * 支持苹果CMS V10 两种接口风格:
 *  V1: ?ac=videolist&pg= / ?ac=videolist&ids= / ?ac=videolist&wd=
 *  V2: ?ac=list / ?ac=detail&t=&pg= / ?ac=detail&ids= / ?ac=detail&wd=
 * 内置离线演示源。
 * ================================================= */
const API = (() => {
  /* 安卓App(WebView file://)模式:通用文件访问已放行跨域,所有请求直连,不经代理 */
  const IN_APP = location.protocol === 'file:';
  const CFG = () => DB.getConfig();

  function proxied(url) {
    if (!url) return url;
    if (IN_APP) return url;
    if (!CFG().proxyMode) return url;
    if (/^\/proxy/.test(url) || url.startsWith(location.origin + '/proxy')) return url;
    const host = (() => { try { return new URL(url, location.href).hostname; } catch { return ''; } })();
    if (/^(localhost|127\.|::1)/.test(host)) return url;
    // 路径式前缀:m3u8 内的相对分段地址会解析回代理,形成完整代理链
    return '/proxy/' + String(url).split('#')[0];
  }

  async function fetchTextOnce(url, timeout) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeout);
    try {
      const res = await fetch(proxied(url), { signal: ctl.signal, headers: { 'Accept': 'application/json, text/plain, */*' } });
      if (!res.ok) {
        let body = '';
        try { body = (await res.text()).slice(0, 90); } catch {}
        throw new Error(friendlyNetError(body || ('HTTP ' + res.status)));
      }
      return await res.text();
    } catch (e) {
      if (e.name === 'AbortError') throw new Error('请求超时(' + (timeout / 1000) + 's),源响应太慢或不可达');
      throw new Error(friendlyNetError(e.message || e));
    } finally { clearTimeout(timer); }
  }
  /* 带重试:部分上游连接会偶发中途重置(Failed to fetch / ECONNRESET) */
  async function fetchText(url, timeout = 12000) {
    let lastErr = null;
    for (let i = 0; i < 3; i++) {
      try { return await fetchTextOnce(url, timeout); }
      catch (e) {
        lastErr = e;
        if (/超时/.test(e.message)) throw e;   // 超时不重试(可能源真死)
        await new Promise(r => setTimeout(r, 600 * (i + 1)));
      }
    }
    throw lastErr;
  }

  /* 把底层网络错误翻译成人话 */
  function friendlyNetError(msg) {
    const m = String(msg || '');
    if (/ECONNRESET|reset/i.test(m)) return '连接被重置——该源可能被当前网络屏蔽(换网络/热点试试)';
    if (/failed to fetch|networkerror|load failed/i.test(m)) return '网络不可达——该源可能已被屏蔽或站点失效(换网络/热点试试)';
    if (/ETIMEDOUT|timeout|aborted/i.test(m)) return '连接超时——源不可达或响应过慢';
    if (/ENOTFOUND|getaddrinfo/i.test(m)) return '域名无法解析——检查接口地址拼写';
    if (/ECONNREFUSED/i.test(m)) return '连接被拒绝——服务未开放';
    if (/403/.test(m)) return '被拒绝(403)——站点风控或防盗链';
    if (/404/.test(m)) return '接口不存在(404)——地址路径有误';
    if (/cors|cross-origin/i.test(m)) return '跨域受限——请开启代理模式';
    return m;
  }

  /* 源连通性测试:ac=list 试探 */
  async function testSource(src) {
    const t0 = performance.now();
    try {
      const j = tryJSON(await fetchText(joinUrl(src.api, { ac: 'list', pg: 1 }), 15000));
      const ms = Math.round(performance.now() - t0);
      const n = (j && (Array.isArray(j.list) ? j.list : Array.isArray(j.data) ? j.data : [])).length;
      if (!j || (n === 0 && !j.class)) return { ok: false, ms, error: '响应不是有效的苹果CMS数据' };
      return {
      ok: true, ms, count: n };
    } catch (e) {
      return { ok: false, ms: Math.round(performance.now() - t0), error: (e && e.message) || '失败' };
    }
  }

  /* 某些源直接返回 JSON,部分返回包着 json 的 html */
  function tryJSON(text) {
    try { return JSON.parse(text); } catch {}
    const m = text.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
    if (m) { try { return JSON.parse(m[0]); } catch {} }
    return null;
  }

  function picUrl(src, pic) {
    if (!pic) return '';
    let p = String(pic).trim();
    if (p.startsWith('//')) p = 'https:' + p;
    if (p.startsWith('http')) return proxied(p);
    if (p.startsWith('/')) {
      try { return proxied(new URL(p, src.api).href); } catch { return p; }
    }
    return p;
  }

  /* ---- 归一化 CMS 条目 ---- */
  function normItem(src, v) {
    return {
      id: String(v.vod_id ?? v.id ?? ''),
      name: (v.vod_name ?? v.name ?? '').trim(),
      pic: picUrl(src, v.vod_pic ?? v.pic ?? ''),
      remarks: (v.vod_remarks ?? v.remarks ?? '').trim(),
      year: String(v.vod_year ?? v.year ?? ''),
      area: (v.vod_area ?? v.area ?? ''),
      cls: (v.vod_class ?? v.class ?? v.type_name ?? ''),
      actor: (v.vod_actor ?? v.actor ?? ''),
      director: (v.vod_director ?? v.director ?? ''),
      content: String(v.vod_content ?? v.content ?? '').replace(/<[^>]+>/g, '').replace(/&[a-z]+;/gi, ' ').trim(),
      from: src,
      raw: v,
    };
  }

  /* ---- 解析播放地址:vod_play_from $$$ vod_play_url ---- */
  function parsePlay(v) {
    const froms = String(v.vod_play_from ?? '').split('$$$').map(s => s.trim()).filter(Boolean);
    const urls = String(v.vod_play_url ?? '').split('$$$');
    const groups = [];
    const n = Math.max(froms.length, urls.length);
    for (let i = 0; i < n; i++) {
      const gname = froms[i] || ('线路' + (i + 1));
      const eps = (urls[i] || '').split('#').map(s => s.trim()).filter(Boolean).map(seg => {
        const idx = seg.indexOf('$');
        if (idx > -1) return { name: seg.slice(0, idx).trim(), url: seg.slice(idx + 1).trim() };
        return { name: '第' + (epsCount(groups) + 1) + '集', url: seg };
      });
      groups.push({ name: gname, eps });
    }
    function epsCount(arr) { let c = 0; arr.forEach(g => c += g.eps.length); return c; }
    return groups.filter(g => g.eps.length);
  }

  function pickList(json) {
    if (!json) return { list: [], total: 0, page: 1, pagecount: 1 };
    const list = Array.isArray(json.list) ? json.list : (Array.isArray(json.data) ? json.data : (Array.isArray(json) ? json : []));
    return {
      list,
      total: Number(json.total ?? 0),
      page: Number(json.page ?? 1),
      pagecount: Number(json.pagecount ?? json.page_count ?? 1),
    };
  }

  /* ================= CMS 真实源 ================= */
  const CMS = {
    home: async (src) => {
      /* 部分CMS的 ac=list 无封面、ac=detail 无分类 → 并发两个接口各取所长 */
      const grab = params => fetchText(joinUrl(src.api, params)).then(tryJSON).catch(() => null);
      const [lj, dj] = await Promise.all([grab({ ac: 'list' }), grab({ ac: 'detail', pg: 1 })]);
      const classes = (lj && Array.isArray(lj.class) ? lj.class : [])
        .map(c => ({ type_id: String(c.type_id), type_name: c.type_name }))
        .filter(c => c.type_id && c.type_name && !/顶部|推荐|首页/.test(c.type_name));
      const dList = dj && Array.isArray(dj.list) ? dj.list : [];
      const useDetail = dList.length && dList.some(v => v.vod_pic);
      const { list } = useDetail ? { list: dList } : pickList(lj);
      return { classes, latest: list.map(v => normItem(src, v)) };
    },
    category: async (src, tid, pg = 1) => {
      let j;
      try {
        j = tryJSON(await fetchText(joinUrl(src.api, { ac: 'detail', t: tid, pg })));
        if (!j || (!Array.isArray(j.list))) throw 0;
      } catch {
        j = tryJSON(await fetchText(joinUrl(src.api, { ac: 'videolist', t: tid, pg })));
      }
      const r = pickList(j);
      return { list: r.list.map(v => normItem(src, v)), page: r.page || pg, pagecount: r.pagecount || 1 };
    },
    detail: async (src, ids) => {
      let j;
      try { j = tryJSON(await fetchText(joinUrl(src.api, { ac: 'detail', ids }))); if (!j) throw 0; }
      catch { j = tryJSON(await fetchText(joinUrl(src.api, { ac: 'videolist', ids }))); }
      const { list } = pickList(j);
      return list.map(v => normItem(src, v));
    },
    search: async (src, wd, pg = 1) => {
      let j;
      try {
        j = tryJSON(await fetchText(joinUrl(src.api, { ac: 'detail', wd, pg })));
        if (!j) throw 0;
      } catch {
        j = tryJSON(await fetchText(joinUrl(src.api, { ac: 'videolist', wd, pg })));
      }
      const r = pickList(j);
      return { list: r.list.map(v => normItem(src, v)), page: r.page || pg, pagecount: r.pagecount || 1 };
    },
  };

  function joinUrl(api, params) {
    const [base, hash] = api.split('#');
    const url = new URL(base, location.origin);
    Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
    return url.href;
  }

  /* ================= 内置演示源(离线可用) ================= */
  const LOCAL = IN_APP ? 'file:///android_asset/www_media_demo.mp4' : '/media/demo.mp4';
  const SINT = 'https://media.w3.org/2010/05/sintel/trailer.mp4';
  const OCEANS = 'https://vjs.zencdn.net/v/oceans.mp4';
  const HLS = IN_APP ? 'https://test-streams.mux.dev/pts_shift/master.m3u8' : '/proxy2/https://test-streams.mux.dev/pts_shift/master.m3u8';
  const pic = seed => `https://picsum.photos/seed/${seed}/300/450`;

  function demoVod(id, name, seed, remarks, cat, extra, playUrl) {
    return {
      vod_id: id, vod_name: name, vod_pic: pic(seed), vod_remarks: remarks,
      vod_year: '2024', vod_area: extra.area || '欧美', vod_class: cat, vod_actor: extra.actor || '',
      vod_director: extra.director || '', vod_content: extra.content || '演示内容。',
      vod_play_from: '演示线路', vod_play_url: playUrl,
    };
  }
  const ep = (n, url) => `第${String(n).padStart(2, '0')}集$${url}`;

  const DEMO_ITEMS = [
    demoVod(1, '大雄兔', 'bunny1', '正片', '电影', { area: '欧美', director: 'Blender基金会', actor: '大雄兔', content: 'Blender 开源动画短片(本地演示资源,秒开)。' },
      ep(1, LOCAL)),
    demoVod(2, '大象的梦想', 'elephant2', '正片', '电影', { area: '欧美', director: 'Blender基金会', content: '两个角色在无限机器中的奇妙旅程。' },
      ep(1, SINT)),
    demoVod(3, '辛特尔', 'sintel3', '正片', '电影', { area: '欧美', director: 'Blender基金会', content: '女孩寻找小龙的冒险之旅,多码率 HLS 自适应(远程,缓冲较慢)。' },
      '第01集$' + HLS),
    demoVod(4, '钢之泪', 'steel4', '正片', '电影', { area: '欧美', director: 'Blender基金会', content: '阿姆斯特丹的未来科幻短片。' },
      ep(1, SINT)),
    demoVod(5, '烈焰引擎', 'blaze5', '预告', '电影', { area: '欧美', content: '炫酷的引擎特效演示。' }, ep(1, LOCAL)),
    demoVod(6, '大逃亡', 'escape6', '高清', '电影', { area: '欧美', content: '一次策划已久的越狱行动(大文件,测缓冲)。' }, ep(1, OCEANS)),
    demoVod(7, '欢乐兜风', 'joyride7', '正片', '电影', { area: '欧美', content: '一场说走就走的兜风。' }, ep(1, LOCAL)),
    demoVod(8, '欢乐时光', 'fun8', '正片', '电影', { area: '欧美', content: '全家欢喜剧短片。' }, ep(1, SINT)),
    demoVod(9, '融化了', 'melt9', '正片', '电影', { area: '欧美', content: '炎炎夏日里的一场 meltdown。' }, ep(1, LOCAL)),
    demoVod(10, '斯巴鲁旅行记', 'subaru10', '正片', '纪录', { area: '欧美', content: '公路与越野实拍测评。' }, ep(1, SINT)),
    demoVod(11, 'GTI测评', 'gti11', '正片', '纪录', { area: '欧美', content: '钢炮标杆深度测评。' }, ep(1, LOCAL)),
    demoVod(12, '狂飙之路', 'bullrun12', '第1季', '纪录', { area: '欧美', content: '横跨美国的拉力赛纪实,共2集,测选集切换。' },
      ep(1, LOCAL) + '#' + ep(2, SINT)),
    demoVod(13, '一千美元的车', 'grand13', '正片', '纪录', { area: '欧美', content: '一千美元能买到什么车?' }, ep(1, SINT)),
  ];

  const DEMO = {
    home: async () => ({
      classes: [{ type_id: '1', type_name: '电影' }, { type_id: '2', type_name: '纪录' }],
      latest: DEMO_ITEMS.map(v => normItem(DEMO_SRC, v)),
    }),
    category: async (_s, tid, pg = 1) => {
      const list = DEMO_ITEMS.filter(v => v.vod_class === (tid === '1' ? '电影' : '纪录'));
      return { list: list.map(v => normItem(DEMO_SRC, v)), page: 1, pagecount: 1 };
    },
    detail: async (_s, ids) => DEMO_ITEMS.filter(v => String(v.vod_id) === String(ids)).map(v => normItem(DEMO_SRC, v)),
    search: async (_s, wd) => ({
      list: DEMO_ITEMS.filter(v => matchName(v.vod_name, wd) || (v.vod_content || '').includes(wd)).map(v => normItem(DEMO_SRC, v)),
      page: 1, pagecount: 1,
    }),
  };

  const DEMO_SRC = { id: 'demo', name: '演示源(内置,离线可用)', api: '' };
  function realAdapter(src) { return (!src || src.id === 'demo' || !src.api) ? DEMO : CMS; }

  /* ================= 对外接口 ================= */
  function adapterOf(src) { return realAdapter(src); }

  /* 拼音/首字母匹配(依赖 pinyin-pro,加载失败自动退化为普通包含匹配) */
  function matchName(name, kw) {
    if (!name || !kw) return false;
    const n = name.toLowerCase();
    const k = kw.toLowerCase().trim();
    if (n.includes(k)) return true;
    const P = window.pinyinPro;
    if (!P || !/^[a-zA-Z]+$/.test(k)) return false;
    try {
      const ini = P.pinyin(name, { pattern: 'first', toneType: 'none', type: 'array' }).join('');
      if (ini.includes(k)) return true;
      const full = P.pinyin(name, { toneType: 'none', type: 'array' }).join('').replace(/\s+/g, '');
      return full.includes(k);
    } catch { return false; }
  }

  /* 并发池:全网搜索所有源(onProgress(res, done, total) 每源完成即回调) */
  async function searchAll(wd, onProgress) {
    const srcs = DB.getSources();
    const pool = Math.min(Math.max(1, Number(DB.getConfig().multiSearch) || 6), 12);
    const results = [];
    let cursor = 0;
    const worker = async () => {
      while (cursor < srcs.length) {
        const src = srcs[cursor++];
        const t0 = performance.now();
        try {
          const r = await realAdapter(src).search(src, wd);
          const ms = Math.round(performance.now() - t0);
          const res = { srcId: src.id, srcName: src.name, list: r.list, ms, error: null };
          results.push(res);
          if (onProgress) { try { onProgress(res, results.length, srcs.length); } catch (_e) {} }
        } catch (e) {
          const res = { srcId: src.id, srcName: src.name, list: [], ms: Math.round(performance.now() - t0), error: (e && e.message) || '请求失败' };
          results.push(res);
          if (onProgress) { try { onProgress(res, results.length, srcs.length); } catch (_e) {} }
        }
      }
    };
    await Promise.all(Array(Math.min(pool, srcs.length)).fill(0).map(worker));
    return results;
  }

  function rankCls(c) {
    const n = (c.type_name || '') + (c.type_id || '');
    if (/电影|剧|电视|连续/.test(n)) return 2;
    if (/动漫|动画|综艺/.test(n)) return 1;
    return 0;
  }

  /* 拼音首字母全源搜索:纯字母关键词时,CMS服务端搜不中中文片名,
     改为并发拉取各源首页+主要分类第一页,本地按拼音首字母/全拼过滤 */
  async function searchPinyinAll(wd, onProgress) {
    const srcs = DB.getSources().filter(s => s.api);
    const pool = Math.min(Math.max(1, Number(DB.getConfig().multiSearch) || 6), 12);
    const results = [];
    let cursor = 0;
    const worker = async () => {
      while (cursor < srcs.length) {
        const src = srcs[cursor++];
        const t0 = performance.now();
        try {
          const seen = new Set();
          const hits = [];
          const push = it => {
            if (it && it.name && !seen.has(it.name) && matchName(it.name, wd)) { seen.add(it.name); hits.push(it); }
          };
          const home = await realAdapter(src).home(src);
          (home.latest || []).forEach(push);
          /* 优先影视主分类(电影/剧集),扫前 5 页;每源约 ≤40 次请求 */
          const cls = (home.classes || []).slice().sort((a, b) => rankCls(b) - rankCls(a)).slice(0, 8);
          await Promise.all(cls.map(async c => {
            for (let pg = 1; pg <= 5; pg++) {
              try { const r = await realAdapter(src).category(src, c.type_id, pg); r.list.forEach(push); } catch (e) { break; }
            }
          }));
          const res = { srcId: src.id, srcName: src.name, list: hits, ms: Math.round(performance.now() - t0), error: null };
          results.push(res);
          if (onProgress) { try { onProgress(res, results.length, srcs.length); } catch (_e) {} }
        } catch (e) {
          const res = { srcId: src.id, srcName: src.name, list: [], ms: Math.round(performance.now() - t0), error: (e && e.message) || '请求失败' };
          results.push(res);
          if (onProgress) { try { onProgress(res, results.length, srcs.length); } catch (_e) {} }
        }
      }
    };
    await Promise.all(Array(Math.min(pool, srcs.length)).fill(0).map(worker));
    return results;
  }

  /* 换源查找:在全部源里找同名影片 */
  async function findEverywhere(title, excludeSrcId) {
    const groups = await searchAll(title);
    const out = [];
    groups.forEach(g => {
      if (g.srcId === excludeSrcId || g.error) return;
      g.list.forEach(it => {
        if (it.name === title || it.name.replace(/[(（].*$/, '') === title) {
          out.push({ srcId: g.srcId, srcName: g.srcName, vodId: it.id, name: it.name, pic: it.pic, remarks: it.remarks, ms: g.ms });
        }
      });
    });
    out.sort((a, b) => a.ms - b.ms);
    return out;
  }

  /* 清晰度权重:备注解析(蓝光/4K > 1080 > 720 > 普通 > 抢先) */
  function qualityRank(remarks) {
    const r = String(remarks || '');
    if (/2160|4k|8k|蓝光/i.test(r)) return 6;
    if (/1080|高清|hd/i.test(r)) return 5;
    if (/720|超清/i.test(r)) return 4;
    if (/抢先|ts版|枪版|cam/i.test(r)) return 1;
    if (/正片|完结/i.test(r)) return 3;
    return 2;
  }

  /* App 直连:WebDAV PROPFIND 解析(JS 版) */
  function parseDavXmlJs(xml) {
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

  /* App 直连列目录:webdav/alist 统一 */
  async function listDriveDirect(drive, sub) {
    const authVal = DB.driveAuth(drive);
    if (drive.type === 'alist') {
      const res = await fetch(drive.url.replace(/\/+$/, '') + '/api/fs/list', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(authVal ? { authorization: authVal } : {}) },
        body: JSON.stringify({ path: sub || '/', password: '', page: 1, per_page: 0, refresh: false }),
      });
      const j = await res.json();
      if (j.code !== 200 || !j.data) throw new Error(j.message || ('Alist 返回 ' + j.code));
      const base = (sub || '/').endsWith('/') ? (sub || '/') : (sub || '/') + '/';
      return (j.data.content || []).map(f => ({ name: f.name, path: base + f.name + (f.is_dir ? '/' : ''), dir: !!f.is_dir, size: f.size || 0 }));
    }
    const target = drive.url.replace(/\/+$/, '') + (sub.startsWith('/') ? sub : '/' + sub);
    const headers = { Depth: '1', 'content-type': 'application/xml' };
    if (authVal) headers.authorization = 'Basic ' + btoa(unescape(encodeURIComponent(authVal)));
    const res = await fetch(target, {
      method: 'PROPFIND', headers,
      body: '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/><d:getcontentlength/></d:prop></d:propfind>',
    });
    if (res.status !== 207) throw new Error('WebDAV 返回 ' + res.status);
    return parseDavXmlJs(await res.text());
  }

  /* ---------- 仓库配置解析(单仓 sites / 多仓 urls·storeHouse) ---------- */
  function resolveApi(api, repoBase) {
    let a = String(api || '').trim();
    if (!a) return null;
    a = a.replace(/^clan:\/\/localhost\//i, '');
    if (/^https?:\/\//i.test(a)) return a;
    try { return new URL(a, repoBase).href; } catch { return null; }
  }

  function parseRepoConfig(text, repoBase) {
    const j = tryJSON(text);
    if (!j || typeof j !== 'object') return { type: 'invalid' };
    if (Array.isArray(j.urls) || Array.isArray(j.storeHouse)) {
      const repos = (j.urls || []).map(x => ({ name: x.name || x.sourceName || '', url: x.url || x.sourceUrl || '' }))
        .concat((j.storeHouse || []).map(x => ({ name: x.sourceName || '', url: x.sourceUrl || '' })))
        .filter(x => /^https?:\/\//i.test(x.url));
      return repos.length ? { type: 'multi', repos } : { type: 'empty' };
    }
    if (Array.isArray(j.sites)) {
      const sites = [];
      const skippedNames = [];
      j.sites.forEach(s => {
        const api = resolveApi(s.api, repoBase);
        const typeOk = s.type === 0 || s.type === 1;
        const looksCms = /provide\/vod/i.test(String(s.api || ''));
        if (api && (typeOk || looksCms)) sites.push({ name: s.name || s.key || '未命名', api });
        else skippedNames.push(s.name || s.key || '未命名');
      });
      return { type: 'sites', sites, skipped: skippedNames.length, skippedNames };
    }
    return { type: 'invalid' };
  }

  async function fetchRepo(url) {
    const text = await fetchText(proxied(url), 15000);
    return parseRepoConfig(text, url);
  }

  /* 详情缓存,避免重复请求 */
  const detailCache = new Map();
  async function detailOf(src, id) {
    const k = src.id + '|' + id;
    if (detailCache.has(k)) return detailCache.get(k);
    const list = await realAdapter(src).detail(src, id);
    const item = list[0] || null;
    if (item) detailCache.set(k, item);
    return item;
  }

  return {
    proxied, picUrl, normItem, parsePlay, adapterOf, matchName, qualityRank, testSource, IN_APP, listDriveDirect, searchPinyinAll,
    home: (src) => realAdapter(src).home(src),
    category: (src, tid, pg) => realAdapter(src).category(src, tid, pg),
    detailOf, search: (src, wd, pg) => realAdapter(src).search(src, wd, pg),
    searchAll, findEverywhere,
    parseRepoConfig, fetchRepo,
  };
})();
