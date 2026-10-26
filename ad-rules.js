/* 影视TV · M3U8 广告切片过滤引擎(浏览器/Node 双端共用)
 * 能滤:
 *   - URL 特征匹配的贴片/插入切片广告(含博彩/赌博类:bet、casino、六合彩、彩票、开元/威尼斯/金沙等)
 *   - DISCONTINUITY 包裹的广告块
 *   - HLS 标准广告标记 #EXT-X-CUE-OUT ~ #EXT-X-CUE-IN 之间的切片(跑马灯/博彩贴片常走此通道)
 * 不能滤:烧录在画面像素里的跑马灯水印(那是视频画面内容本身,任何 URL/切片规则都无能为力,只能靠播放器遮罩忽略)
 */
(function (root) {
  /* 内置广告 URL 特征(可被外部扩展)
   * 覆盖:通用广告目录 / 博彩·赌博类贴片(跑马灯引流、六合彩、彩票、境外博彩站等) */
  const AD_URL_PATTERNS = [
    /\/ad[\/_\-\.]/i,           // /ad/ 目录
    /(^|[\/\.\-_])ads?([\/\.\-_]|$)/i,
    /advert/i,
    /promot/i,
    /\/gg[0-9]*[\/\.]/i,        // /gg/ 广告拼音目录
    /guanggao/i,
    /\/yugao[\/\.]/i,           // 预告引流
    /\/vad[\/\.]/i,
    /adplayer/i,
    /\/cms\/ad/i,
    /* ---- 博彩 / 赌博类贴片广告 ---- */
    /(^|[\/\.\-_])bet([\/\.\-_]|$)/i,   // bet365 等
    /(casino|gamble|gambl)/i,           // 赌场/博彩英文
    /(博彩|赌博|賭博|赌场|六合彩|彩票|外围|私彩)/i,  // 中文博彩词(避开真人/开元/威尼斯等易误伤影视 URL 的词)
    /(du[0-9]*(cai|bo)|piaoyou|piaojing|caitong|caipiao|liuhe|lhc)/i, // 赌彩/彩票/六合 拼音
    /(yulecheng|太阳城|彩票|bet\d{2,3}|1xbet|pussy|\.cc\/)/i, // 博彩站常见特征
    /(phish|钓鱼|诈骗)/i,
  ];

  function isAdUrl(u) {
    if (!u) return false;
    return AD_URL_PATTERNS.some(function (re) { return re.test(u); });
  }

  /* 过滤 m3u8 文本:
   * 1) EXTINF+URI 对:URI 命中广告规则 → 成对剔除
   * 2) DISCONTINUITY 包裹块:块内任一切片命中 → 整块剔除(含边界标记)
   * 返回 { text, removed, removedUrls }
   */
  function filterM3U8(text) {
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
      if (inAd) { i++; continue; }
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
        const adInBlock = block.filter(function (l) { return !l.trim().startsWith('#') && l.trim() && isAdUrl(l.trim()); });
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
        if (uri && !uri.startsWith('#') && isAdUrl(uri)) {
          removedUrls.push(uri);
          i = j + 1; // 剔除 EXTINF 与 URI
          continue;
        }
      }
      out.push(line); i++;
    }
    return { text: out.join('\n'), removed: removedUrls.length, removedUrls: removedUrls };
  }

  const AdFilter = { isAdUrl: isAdUrl, filterM3U8: filterM3U8, AD_URL_PATTERNS: AD_URL_PATTERNS };
  root.AdFilter = AdFilter;
  if (typeof module !== 'undefined' && module.exports) module.exports = AdFilter;
})(typeof window !== 'undefined' ? window : globalThis);
