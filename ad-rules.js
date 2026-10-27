/* 影视TV · M3U8 广告切片过滤引擎(浏览器/Node 双端共用)
 *
 * 规则清单见 docs/ad-filter-rules.md,代码内的规则表为 RULES(下方第 9-40 行),
 * 结构性检测参数为 RULE_CONF。三层过滤:
 *   ① URL 关键词规则(RULES):广告目录/文件名、博彩赌博贴片、诈骗引流
 *   ② HLS 标记规则:#EXT-X-CUE-OUT~CUE-IN 区间、DISCONTINUITY 包裹块
 *   ③ 结构规则(filterStructural):少量切片来自其他目录/域名(采集站插片的主流手法)
 * 不能滤:烧录在画面像素里的跑马灯/水印(属于画面内容,只能靠播放器遮罩)
 */
(function (root) {
  /* ============ 规则表(改规则只改这里)============
   * 每条规则 = 正则 + 说明。命中任一条即判为广告切片。
   * 规则分 3 类:
   *   A. 广告目录/文件名特征(通用)
   *   B. 博彩·赌博类贴片(跑马灯引流、境外博彩站)
   *   C. 诈骗/钓鱼引流
   * 扩展方式:在运行时 window.AdFilter.RULES.push({ re: /.../i, desc: '...' }) 即可,无需改包。
   */
  const RULES = [
    /* ---- A. 通用广告目录 / 文件名 ---- */
    { re: /\/ad[\/_\-\.]/i, desc: '/ad/ 开头的广告目录' },
    { re: /(^|[\/\.\-_])ads?([\/\.\-_]|$)/i, desc: 'ads / ad 独立路径段' },
    { re: /advert/i, desc: 'advert/advertisement' },
    { re: /promot/i, desc: 'promo/promotion 推广' },
    { re: /\/gg[0-9]*[\/\.]/i, desc: '/gg/ 广告拼音目录(guanggao)' },
    { re: /guanggao/i, desc: 'guanggao 广告拼音' },
    { re: /\/yugao[\/\.]/i, desc: '/yugao/ 预告引流' },
    { re: /\/vad[\/\.]/i, desc: '/vad/ 视频广告目录' },
    { re: /adplayer/i, desc: 'adplayer 广告播放器' },
    { re: /\/cms\/ad/i, desc: '/cms/ad' },
    { re: /adjump/i, desc: 'adjump 贴片跳转(暴风系 /video/adjump/time/)' },
    /* ---- B. 博彩 / 赌博类贴片 ---- */
    { re: /(^|[\/\.\-_])bet([\/\.\-_]|$)/i, desc: 'bet 独立段(bet365 等)' },
    { re: /(casino|gamble|gambl)/i, desc: 'casino/gamble 赌场英文' },
    { re: /(博彩|赌博|賭博|赌场|六合彩|彩票|外围|私彩)/i, desc: '中文博彩词(已避开"真人/开元/威尼斯"等易误伤词)' },
    { re: /(du[0-9]*(cai|bo)|piaoyou|piaojing|caitong|caipiao|liuhe|lhc)/i, desc: '赌彩/彩票/六合拼音' },
    { re: /(yulecheng|太阳城|bet\d{2,3}|1xbet|pussy|\.cc\/)/i, desc: '博彩站常见特征' },
    /* ---- C. 诈骗 / 钓鱼 ---- */
    { re: /(phish|钓鱼|诈骗)/i, desc: '钓鱼/诈骗引流' },
  ];
  /* 兼容旧接口:外部仍可用 AdFilter.AD_URL_PATTERNS */
  const AD_URL_PATTERNS = RULES.map(function (r) { return r.re; });

  /* ---- 结构性规则参数(见 filterStructural)----
   * MIN_SEG:切片数低于此值不做结构判断(样本太少)
   * DOM_SHARE:主流目录占比达到此比例,才认为存在"正常目录"
   * OUTLIER_SHARE:少数派目录占比不超过此值才判为广告(避免误杀合法多 CDN)
   * OUTLIER_MIN:少数派目录条数下限(<=2 条时按此放宽)
   */
  const RULE_CONF = { MIN_SEG: 20, DOM_SHARE: 0.6, OUTLIER_SHARE: 0.08, OUTLIER_MIN: 2 };

  function isAdUrl(u) {
    if (!u) return false;
    return RULES.some(function (r) { return r.re.test(u); });
  }

  /* 切片 URI 判定:先按原文查,再把相对路径解析成绝对地址查一次。
   * 采集站的 playlists 里切片常写成相对路径(如 gg/promo.ts、AD/x.mp4),
   * 而多数规则(如 /gg/、/ad/)带前导斜杠,只查原文会漏判。 */
  function isAdUri(u, base) {
    if (!u) return false;
    if (isAdUrl(u)) return true;
    if (!base) return false;
    try { return isAdUrl(new URL(u, base).href); } catch (_e) { return false; }
  }

  /* 结构性广告检测:采集站插广告的通用特征——少量切片来自「另一个目录/另一个域名」
   * (实测:暴风 /video/adjump/time/、360 外日期目录、量子 /2026xxxx 外路径)
   * 规则:以目录前缀(协议+域名+目录)分组,主流组占比 >=60% 时,占比 <=8%(且 <=2 条起)的少数派组视为广告整组剔除。
   * 没有明显主流组(多 CDN 轮转的合法播放列表)时不动,避免误杀。
   */
  function dirPrefix(absUrl) {
    try {
      const u = new URL(absUrl);
      const p = u.pathname;
      const i = p.lastIndexOf('/');
      return u.protocol + '//' + u.host + (i > 0 ? p.slice(0, i) : '');
    } catch (_e) { return ''; }
  }
  function filterStructural(lines, baseUrl, removedUrls) {
    const entries = [];
    for (let i = 0; i < lines.length; i++) {
      const l = (lines[i] || '').trim();
      if (!l || l.charAt(0) === '#') continue;
      let extinf = -1;
      for (let j = i - 1; j >= 0 && j >= i - 3; j--) {
        const p = (lines[j] || '').trim();
        if (/^#EXTINF/i.test(p)) { extinf = j; break; }
        if (p && p.charAt(0) !== '#') break;
      }
      let abs = l;
      try { abs = new URL(l, baseUrl).href; } catch (_e) {}
      entries.push({ i: i, extinf: extinf, abs: abs, pre: dirPrefix(abs) });
    }
    if (entries.length < RULE_CONF.MIN_SEG) return lines; // 切片太少,样本不足不判断
    const counts = {};
    entries.forEach(function (x) { counts[x.pre] = (counts[x.pre] || 0) + 1; });
    const sorted = Object.keys(counts).sort(function (a, b) { return counts[b] - counts[a]; });
    if (!sorted.length) return lines;
    const dominant = sorted[0];
    if (counts[dominant] / entries.length < RULE_CONF.DOM_SHARE) return lines; // 无主流目录 → 合法多源,跳过
    const limit = Math.max(RULE_CONF.OUTLIER_MIN, Math.floor(entries.length * RULE_CONF.OUTLIER_SHARE));
    const drop = new Set();
    entries.forEach(function (x) {
      if (x.pre === dominant) return;
      if (counts[x.pre] > limit) return;   // 少数派占比不小,视为合法分片
      drop.add(x.i);
      if (x.extinf >= 0) drop.add(x.extinf);
      removedUrls.push(x.abs);
    });
    if (!drop.size) return lines;
    return lines.filter(function (_l, i) { return !drop.has(i); });
  }

  /* 过滤 m3u8 文本:
   * 1) EXTINF+URI 对:URI 命中广告规则 → 成对剔除
   * 2) DISCONTINUITY 包裹块:块内任一切片命中 → 整块剔除(含边界标记)
   * 3) 结构性少数派目录剔除(需传 baseUrl,主播放列表已跳过)
   * 返回 { text, removed, removedUrls }
   */
  function filterM3U8(text, baseUrl) {
    if (!text || text.indexOf('#EXTM3U') === -1) return { text: text, removed: 0, removedUrls: [] };
    const lines = text.split(/\r?\n/);
    const out = [];
    const removedUrls = [];
    let i = 0;
    let inAd = false;   // HLS SCTE-35 / CUE 广告区间标记
    while (i < lines.length) {
      const line = lines[i];
      // HLS 标准广告标记:#EXT-X-CUE-OUT 到 #EXT-X-CUE-IN 之间的切片整段跳过
      // (跑马灯/博彩贴片常借这个通道插入,比靠 URL 特征更稳)
      if (/^#EXT-X-CUE-OUT/i.test(line) && !/CUE-OUT-CONT/i.test(line)) { inAd = true; i++; continue; }
      if (/^#EXT-X-CUE-IN/i.test(line)) { inAd = false; i++; continue; }
      if (inAd) {
        // 区间内的切片也要计入 removed,否则统计恒为 0、界面提示不出现
        const seg = line.trim();
        if (seg && seg.charAt(0) !== '#') {
          let abs = seg;
          try { abs = new URL(seg, baseUrl || '').href; } catch (_e) {}
          removedUrls.push(abs);
        }
        i++; continue;
      }
      // DISCONTINUITY 广告块:向前看整块
      if (/^#EXT-X-DISCONTINUITY/i.test(line)) {
        let j = i + 1;
        const block = [];
        let blockHasUri = false;
        while (j < lines.length && !/^#EXT-X-DISCONTINUITY/i.test(lines[j]) && !/^#EXT-X-ENDLIST/i.test(lines[j])) {
          block.push(lines[j]);
          if (!lines[j].trim().startsWith('#') && lines[j].trim()) blockHasUri = true;
          j++;
        }
        const adInBlock = block.filter(function (l) { return !l.trim().startsWith('#') && l.trim() && isAdUri(l.trim(), baseUrl); });
        if (blockHasUri && adInBlock.length) {
          removedUrls.push.apply(removedUrls, adInBlock);
          i = j; // 整块剔除(含 DISCONTINUITY 标记)
          continue;
        }
        out.push(line); i++; continue;
      }
      // EXTINF + URI 对
      if (/^#EXTINF/i.test(line)) {
        let j = i + 1;
        while (j < lines.length && (lines[j].trim() === '' || lines[j].trim().startsWith('#'))) j++;
        const uri = (lines[j] || '').trim();
        if (uri && !uri.startsWith('#') && isAdUri(uri, baseUrl)) {
          removedUrls.push(uri);
          i = j + 1; // 剔除 EXTINF 与 URI
          continue;
        }
      }
      out.push(line); i++;
    }
    let finalLines = out;
    if (baseUrl && !/#EXT-X-STREAM-INF/i.test(text)) {
      try { finalLines = filterStructural(out, baseUrl, removedUrls); } catch (_e) { finalLines = out; }
    }
    return { text: finalLines.join('\n'), removed: removedUrls.length, removedUrls: removedUrls };
  }

  const AdFilter = { isAdUrl: isAdUrl, isAdUri: isAdUri, filterM3U8: filterM3U8, RULES: RULES, RULE_CONF: RULE_CONF, AD_URL_PATTERNS: AD_URL_PATTERNS };
  root.AdFilter = AdFilter;
  if (typeof module !== 'undefined' && module.exports) module.exports = AdFilter;
})(typeof window !== 'undefined' ? window : globalThis);
