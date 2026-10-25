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

  window.Scraper = {
    parseFileName: parseFileName,
    scrapeFile: scrapeFile,
    doubanSuggest: doubanSuggest,
    doubanDetail: doubanDetail,
    cacheGet: cacheGet,
    cacheSet: cacheSet,
    IN_APP: IN_APP,
  };
})();
