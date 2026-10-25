/* ============ 字幕解析:SRT / ASS / VTT → VTTCue 数组,GBK 自动识别 ============ */
(function () {
  /* 智能解码:先 UTF-8,出现替换符(乱码)再试 GBK */
  function decodeSmart(buf) {
    try {
      const t = new TextDecoder('utf-8', { fatal: false }).decode(buf);
      if (t.indexOf('\uFFFD') === -1) return t.replace(/^\uFEFF/, '');
    } catch (e) {}
    try { return new TextDecoder('gbk').decode(buf); } catch (e) {}
    return new TextDecoder('utf-8').decode(buf);
  }

  const toSec = function (st) {
    // 支持 h:mm:ss.cc / mm:ss.cc / ss.cc
    const m = String(st).trim().match(/(?:(\d+):)?(\d{1,2}):(\d{1,2})[.,](\d{1,3})/);
    if (!m) return parseFloat(st) || 0;
    return (+m[1] || 0) * 3600 + (+m[2]) * 60 + (+m[3]) + (+((m[4] || '0').padEnd(3, '0')) / 1000);
  };

  function parseSRT(text) {
    const cues = [];
    text.replace(/\r/g, '').replace(/^\uFEFF/, '').split(/\n\n+/).forEach(function (block) {
      const lines = block.split('\n').filter(function (l) { return l.trim(); });
      if (lines.length < 2) return;
      const tm = lines.find(function (l) { return /-->/.test(l); });
      if (!tm) return;
      const p = tm.split('-->');
      const start = toSec(p[0]);
      const end = toSec(p[1].trim().split(/\s+/)[0]);
      const ti = lines.indexOf(tm);
      const text = lines.slice(ti + 1).join('\n').replace(/<[^>]+>/g, '').trim();
      if (text && end > start) cues.push({ start: start, end: end, text: text });
    });
    return cues;
  }

  function parseVTT(text) {
    return parseSRT(text.replace(/^WEBVTT[^\n]*\n/, ''));
  }

  /* 简版 ASS:取 Dialogue 文本,剥离特效标签 */
  function parseASS(text) {
    const cues = [];
    const fmtLine = text.split(/\r?\n/).find(function (l) { return /^\s*Format:/i.test(l) && /Text/i.test(l); });
    if (!fmtLine) return cues;
    const keys = fmtLine.replace(/^\s*Format:\s*/i, '').split(',').map(function (k) { return k.trim().toLowerCase(); });
    const ti = keys.indexOf('start'), te = keys.indexOf('end'), tx = keys.indexOf('text');
    text.split(/\r?\n/).forEach(function (l) {
      if (!/^Dialogue:/i.test(l)) return;
      const parts = l.replace(/^Dialogue:/i, '').split(',');
      if (parts.length < Math.max(ti, te, tx) + 1) return;
      const start = toSec(parts[ti]);
      const end = toSec(parts[te]);
      let t = parts.slice(tx).join(',').replace(/\{[^}]*\}/g, '').replace(/\\N/gi, '\n').trim();
      if (t && end > start) cues.push({ start: start, end: end, text: t });
    });
    return cues;
  }

  function parseAny(text, name) {
    if (/^\uFEFF?WEBVTT/i.test(text) || /-->/.test(text.split('\n')[1] || '')) return parseVTT(text);
    if (/^\s*\[Script Info\]/im.test(text) || /\.ass$|\.ssa$/i.test(name || '')) return parseASS(text);
    return parseSRT(text);
  }

  window.Subtitles = {
    decodeSmart: decodeSmart,
    parse: parseAny,
    parseSRT: parseSRT,
    parseASS: parseASS,
    toSec: toSec,
  };
})();
