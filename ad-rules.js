/* 影视TV · M3U8 广告切片过滤引擎(浏览器/Node 双端共用)
 * 能滤:URL 特征匹配的贴片/插入切片广告、DISCONTINUITY 包裹的广告块
 * 不能滤:烧录在画面像素里的跑马灯水印(那是画面内容本身)
 */
(function (root) {
  /* 内置广告 URL 特征(可被外部扩展) */
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
    while (i < lines.length) {
      const line = lines[i];
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
