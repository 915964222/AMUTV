/* ============ 刮削引擎(豆瓣数据源):文件名识别 → 评分/海报/简介/演员表 ============ */
/* PC:走本地代理(h= 注入 Referer);安卓 App:走 YSTV.fetchText Java 桥(可设 Referer) */
(function () {
  const IN_APP = location.protocol === 'file:';
  const CK = 'tvw_scrape';

  function cacheGet(k) {
    try { return (JSON.parse(localStorage.getItem(CK) || '{}')[k]) || null; } catch (e) { return null; }
  }
  function cacheSet(k, v) {
    try {
      const m = JSON.parse(localStorage.getItem(CK) || '{}');
      m[k] = Object.assign({ _t: Date.now() }, v);
      localStorage.setItem(CK, JSON.stringify(m));
    } catch (e) {}
  }

  /* 文件名识别:标题 + 年份 */
  function parseFileName(name) {
    let base = String(name).replace(/\.[a-z0-9]{2,4}$/i, '');
    const ym = base.match(/(19\d{2}|20\d{2})/);
    const year = ym ? ym[1] : '';
    base = base.replace(/(1080[pP]|720[pP]|2160[pP]|4[kK]|BluRay|Blu-ray|WEB-?DL|WEBRip|x264|x26[45]|HEVC|HDR10?|DV|Dolby|CHS|CHT|ENG|简繁|简体|繁体|国语|粤语|中字|双语|修复|典藏|收藏版|无水印|4K)/g, ' ');
    base = base.replace(/[._\-\[\]()]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (year) {
      const yi = base.lastIndexOf(year);
      if (yi > 2) base = base.slice(0, yi).trim();
    }
    if (!base) base = String(name).replace(/\.[a-z0-9]{2,4}$/i, '');
    return { title: base, year: year };
  }

  /* 网络:PC 经代理(h 注入 Referer);App 走 Java 桥 */
  const DB_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 Chrome/120 Mobile Safari/604.1';
  async function fetchText(url, referer) {
    if (IN_APP && window.YSTV && window.YSTV.fetchText) {
      return window.YSTV.fetchText(url, referer || '');
    }
    let u = '/proxy/' + url;
    const hs = [];
    if (referer) hs.push('Referer: ' + referer);
    hs.push('User-Agent: ' + DB_UA);
    hs.forEach(function (h) { u += (u.indexOf('?') > -1 ? '&' : '?') + 'h=' + encodeURIComponent(h); });
    const r = await fetch(u);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.text();
  }

  async function doubanSuggest(q) {
    const t = await fetchText('https://movie.douban.com/j/subject_suggest?q=' + encodeURIComponent(q), 'https://movie.douban.com/');
    return JSON.parse(t).filter(function (x) { return x.type === 'movie' || x.type === 'tv'; });
  }

  async function doubanDetail(id) {
    const t = await fetchText('https://m.douban.com/rexxar/api/v2/movie/' + id, 'https://m.douban.com/');
    const d = JSON.parse(t);
    return {
      id: id,
      title: d.title || '',
      original: d.original_title || '',
      year: d.year || '',
      rating: d.rating ? d.rating.value : null,
      ratingCount: d.rating ? d.rating.count : 0,
      stars: d.rating ? d.rating.star_count : 0,
      poster: (d.pic && (d.pic.large || d.pic.normal)) || d.cover_url || '',
      intro: d.intro || '',
      cast: (d.actors || []).slice(0, 8).map(function (a) { return a.name; }),
      directors: (d.directors || []).map(function (a) { return a.name; }),
      genres: d.genres || [],
      countries: d.countries || [],
      cardSubtitle: d.card_subtitle || '',
      doubanUrl: 'https://movie.douban.com/subject/' + id + '/',
    };
  }

  /* 按文件名刮削:suggest 搜索 → 取最匹配 → 详情;带缓存 */
  async function scrapeFile(fileName) {
    const hit = cacheGet(fileName);
    if (hit) return hit;
    const f = parseFileName(fileName);
    let cands = [];
    const queries = [];
    if (f.year) queries.push(f.title + ' ' + f.year);
    queries.push(f.title);
    const mainWord = f.title.split(' ')[0];
    if (mainWord && mainWord !== f.title) queries.push(mainWord);
    for (const q of queries) {
      if (cands.length) break;
      try { cands = await doubanSuggest(q); } catch (e) {}
    }
    if (!cands.length) {
      const miss = { fileName: fileName, title: f.title, year: f.year, unmatched: true };
      cacheSet(fileName, miss);
      return miss;
    }
    let det = null;
    try { det = await doubanDetail(cands[0].id); } catch (e) {}
    const result = Object.assign(
      { fileName: fileName, fileTitle: f.title },
      det || { title: cands[0].title, year: cands[0].year, poster: cands[0].img, unmatched: true },
      { suggestImg: cands[0].img }
    );
    cacheSet(fileName, result);
    return result;
  }

  /* 豆瓣图床反盗链:personage 头像直连 403/418,PC 经代理注入 Referer+UA(App 端 WebView 无 Referer 也过不了,留兜底) */
  function imgProxy(url) {
    if (!url || IN_APP || String(url).indexOf('doubanio.com') === -1) return url;
    return '/proxy/' + url +
      '?h=' + encodeURIComponent('Referer: https://movie.douban.com/') +
      '&h=' + encodeURIComponent('User-Agent: ' + DB_UA);
  }

  /* ============ 全信息面板:豆瓣演员头像 / IMDb评分 / 烂番茄爆米花指数 ============ */

  /* 豆瓣演职员(带定妆头像):celebrities 接口,导演+演员合并 */
  async function doubanCelebs(id) {
    const t = await fetchText('https://m.douban.com/rexxar/api/v2/movie/' + id + '/celebrities?start=0&count=12', 'https://m.douban.com/');
    const d = JSON.parse(t);
    const mk = function (c) {
      return {
        name: c.name || '',
        character: c.character === '导演' ? '导演' : (c.character || ''),
        avatar: (c.avatar && (c.avatar.large || c.avatar.normal)) || '',
      };
    };
    return (d.actors || []).map(mk).slice(0, 10);
  }

  /* IMDb:Cinemeta公共API,中文片名可搜;返回评分+英文片名(烂番茄检索要用) */
  async function imdbFind(title, year) {
    const ck = 'imdb|' + title + '|' + (year || '');
    const hit = cacheGet(ck);
    if (hit) return hit.unmatched ? null : hit;
    const q = encodeURIComponent(title);
    const types = ['movie', 'series'];
    let best = null;
    for (const ty of types) {
      try {
        const t = await fetchText('https://v3-cinemeta.strem.io/catalog/' + ty + '/top/search=' + q + '.json');
        const metas = JSON.parse(t).metas || [];
        if (!metas.length) continue;
        if (year) {
          // 年份±1校验:乱码/冷门词 cinemeta 也会返回热门填充结果,年份对不上不可信
          const y4 = function (s) { const m = String(s || '').match(/\d{4}/); return m ? Number(m[0]) : 0; };
          const m = metas.find(function (x) { const y = y4(x.releaseInfo); return y && Math.abs(y - Number(year)) <= 1; });
          if (!m) continue;
          best = m;
        } else {
          best = metas[0];
        }
        break;
      } catch (e) {}
    }
    if (!best || !best.imdb_id) { cacheSet(ck, { unmatched: true }); return null; }
    let det = null;
    try {
      det = JSON.parse(await fetchText('https://cinemeta-live.strem.io/meta/' + best.type + '/' + best.imdb_id + '.json')).meta || {};
    } catch (e) {}
    const out = {
      imdbId: best.imdb_id,
      imdbRating: (det && det.imdbRating) || '',
      enTitle: (det && det.name) || best.name || '',
      year: (det && det.releaseInfo) || best.releaseInfo || '',
    };
    cacheSet(ck, out);
    return out;
  }

  /* 烂番茄爆米花指数:slug 直接猜测(RT slug=标题小写下划线,数字会301到罗马数字变体)
   * Bing 检索方案已废弃——Bing 对无 Cookie 自动请求很快软封禁 */
  function rtSlug(title) {
    return String(title).toLowerCase()
      .replace(/[’'`]/g, '')
      .replace(/&/g, ' and ')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim().replace(/\s+/g, '_');
  }
  function toRoman(n) {
    const R = [[10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']];
    let s = '';
    for (const p of R) while (n >= p[0]) { s += p[1]; n -= p[0]; }
    return s.toLowerCase();
  }
  const ROMAN = { i: 1, ii: 2, iii: 3, iv: 4, v: 5, vi: 6, vii: 7, viii: 8, ix: 9, x: 10 };
  async function rtPopcorn(enTitle) {
    const ck = 'rt|' + enTitle;
    const hit = cacheGet(ck);
    if (hit) return hit.unmatched ? null : hit;
    const base = rtSlug(enTitle);
    const cands = [];
    if (base) {
      cands.push(base);
      // 数字↔罗马数字双变体(RT 两种都存在,301互跳)
      const dm = base.match(/^(.*_)(\d{1,2})(?=_|$)/);
      if (dm) cands.push(dm[1] + toRoman(Number(dm[2])));
      const rm = base.match(/^(.*_)(x|ix|iv|v{1,3}i{0,3}|i{1,3})(?=_|$)/);
      if (rm && ROMAN[rm[2]]) cands.push(rm[1] + ROMAN[rm[2]]);
    }
    for (const c of cands.slice(0, 3)) {
      try {
        const page = await fetchText('https://www.rottentomatoes.com/m/' + c);
        const jm = page.match(/<script[^>]*id="media-scorecard-json"[^>]*>([\s\S]*?)<\/script>/);
        if (!jm) continue;
        // 标题校验:slug 猜测可能撞上别的影片,页面标题必须与候选一致
        const tm = page.match(/<title>([^<|]+?)\s*\|/);
        if (!tm || rtSlug(tm[1]) !== c) continue;
        const sc = JSON.parse(jm[1]);
        const out = {
          popcorn: (sc.audienceScore && sc.audienceScore.score) || '',
          critics: (sc.criticsScore && sc.criticsScore.score) || '',
          url: 'https://www.rottentomatoes.com/m/' + c,
        };
        if (out.popcorn || out.critics) { cacheSet(ck, out); return out; }
      } catch (e) {}
    }
    cacheSet(ck, { unmatched: true });
    return null;
  }

  /* 详情页全信息并发刮削:豆瓣(评分/简介/头像) + IMDb + 烂番茄;可传入已有豆瓣详情跳过重复请求 */
  async function enrich(title, year, existDouban) {
    const ck = 'enrich|' + title + '|' + (year || '');
    const hit = cacheGet(ck);
    if (hit && hit._done) return hit;
    const out = {};
    const doubanP = (async function () {
      if (existDouban && !existDouban.unmatched) {
        try { out.cast = await doubanCelebs(existDouban.id); } catch (e) {}
        return existDouban;
      }
      const f = { title: String(title), year: year || '' };
      let cands = [];
      for (const q of [f.title + (f.year ? ' ' + f.year : ''), f.title, f.title.split(' ')[0]]) {
        if (cands.length) break;
        try { cands = await doubanSuggest(q); } catch (e) {}
      }
      if (!cands.length) return null;
      try { return await doubanDetail(cands[0].id); } catch (e) { return null; }
    })();
    const imdbP = imdbFind(title, year).catch(function () { return null; });
    out.douban = await doubanP;
    out.imdb = await imdbP;
    if (!out.cast) {
      try {
        out.cast = out.douban && out.douban.id ? await doubanCelebs(out.douban.id) : [];
      } catch (e) { out.cast = []; }
    }
    try {
      out.rt = await rtPopcorn((out.imdb && out.imdb.enTitle) || title);
    } catch (e) { out.rt = null; }
    out._done = true;
    cacheSet(ck, out);
    return out;
  }

  window.Scraper = {
    parseFileName: parseFileName,
    scrapeFile: scrapeFile,
    doubanSuggest: doubanSuggest,
    doubanDetail: doubanDetail,
    doubanCelebs: doubanCelebs,
    imdbFind: imdbFind,
    rtPopcorn: rtPopcorn,
    enrich: enrich,
    imgProxy: imgProxy,
    cacheGet: cacheGet,
    cacheSet: cacheSet,
    IN_APP: IN_APP,
  };
})();
