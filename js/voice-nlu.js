/* 影视TV · 语音意图解析(轻量 NLU)
 *
 * 设计原则:纯函数,不碰 DOM、不发请求 —— 输入一句话,输出结构化意图。
 * 浏览器与 Node 共用同一份实现,便于用 tools/voice-nlu-test.js 做回归自测。
 *
 * 支持的说法(详见 docs/voice-control.md):
 *   搜片  看庆余年 / 我想看繁花 / 搜一下狂飙
 *   控制  暂停 / 继续 / 下一集 / 上一集 / 跳到第 5 集 / 快进 30 秒 / 后退十秒
 *   音量  声音大一点 / 音量调到 50 / 静音 / 取消静音 / 最大声
 *   倍速  1.5 倍速 / 正常速度
 *   画面  全屏 / 退出播放
 *   导航  首页 / 设置 / 直播 / 收藏 / 历史 / 网盘
 *
 * 明确不做:多指令("暂停然后快进")只执行第一条;没有模型泛化,说法表外的走近义兜底或退回搜索。
 */
(function (root) {
  'use strict';

  /* ================= 中文数字 ================= */
  var CN = { '零': 0, '〇': 0, '一': 1, '壹': 1, '两': 2, '二': 2, '贰': 2, '三': 3, '叁': 3, '四': 4, '肆': 4,
    '五': 5, '伍': 5, '六': 6, '陆': 6, '七': 7, '柒': 7, '八': 8, '捌': 8, '九': 9, '玖': 9 };
  var UNIT = { '十': 10, '拾': 10, '百': 100, '佰': 100, '千': 1000, '仟': 1000 };

  /* "十五"→15、"二十五"→25、"一百二"→102(口语省略单位,按百+个位算)、"三点五"→3.5 */
  function cn2num(str) {
    if (str === null || str === undefined) return NaN;
    var s = String(str).trim();
    if (!s) return NaN;
    if (/^\d+(\.\d+)?$/.test(s)) return parseFloat(s);

    var dot = s.indexOf('点');
    if (dot >= 0) {
      var ip = cn2num(s.slice(0, dot));
      var fp = cn2num(s.slice(dot + 1));
      if (isNaN(ip) || isNaN(fp)) return NaN;
      return parseFloat(ip + '.' + fp);
    }

    var total = 0, cur = 0, seen = false;
    for (var i = 0; i < s.length; i++) {
      var ch = s.charAt(i);
      if (CN[ch] !== undefined) { cur = CN[ch]; seen = true; }
      else if (UNIT[ch] !== undefined) {
        if (!seen) cur = 1;
        total += cur * UNIT[ch];
        cur = 0; seen = true;
      } else return NaN;
    }
    if (!seen) return NaN;
    return total + cur;
  }

  /* ================= 文本归一 ================= */
  function norm(t) {
    var s = String(t === null || t === undefined ? '' : t);
    s = s.replace(/[\uFF01-\uFF5E]/g, function (c) { return String.fromCharCode(c.charCodeAt(0) - 0xFEE0); });
    s = s.replace(/\u3000/g, ' ').toLowerCase();
    /* 先护住小数点的数字(1.5 倍速),否则句号规则会把它拆成"1 5" */
    s = s.replace(/(\d)\.(\d)/g, '$1\u0001$2');
    s = s.replace(/[，。！？、,.!?;；:："'“”‘’()（）\[\]【】《》·…—]/g, ' ');
    s = s.replace(/\u0001/g, '.');
    return s.replace(/\s+/g, ' ').trim();
  }

  /* ================= 搜索词清洗 ================= */
  /* 长词优先,避免"帮我搜一下"被"帮我搜"切一半留下"一下" */
  var PREFIX = ['帮我找一下', '帮我搜索一下', '帮我搜一下', '帮我查一下', '给我找一下', '给我搜一下',
    '帮我搜索', '帮我播放', '给我播放', '帮我找', '帮我搜', '帮我查', '给我找', '给我搜', '给我放',
    '我想看看', '我想看', '我要看', '我想听', '麻烦播放', '麻烦放一下', '搜索一下', '搜索下', '搜索',
    '搜一下', '搜搜', '查一下', '查找', '找一下', '找找', '看一下', '看看', '放一下', '播放', '放映',
    '打开', '我要', '我想', '搜', '找', '查', '看', '放'];
  var SUFFIX = ['可以吗', '好不好', '行不行', '谢谢', '吧', '呢', '啊', '呀', '呗', '吗', '哦', '嘛'];

  function stripToTitle(s) {
    var t = String(s || '').trim();
    for (var guard = 0; guard < 8; guard++) {
      var hit = false;
      for (var i = 0; i < PREFIX.length; i++) {
        var p = PREFIX[i];
        /* 必须留出内容,否则"看""搜"这类会把自己吃光 */
        if (t.length > p.length && t.indexOf(p) === 0) { t = t.slice(p.length).trim(); hit = true; break; }
      }
      if (!hit) break;
    }
    for (var j = 0; j < SUFFIX.length; j++) {
      var suf = SUFFIX[j];
      if (t.length > suf.length && t.slice(-suf.length) === suf) { t = t.slice(0, -suf.length).trim(); break; }
    }
    return t;
  }

  /* 纯指令词:即使去动词后为空,也不能当片名去搜 */
  var CTRL_ONLY = /^(播放|暂停|继续|停止|下一集|上一集|下一个|上一个|下一部|上一部|快进|快退|前进|后退|静音|取消静音|全屏|退出全屏|退出|关闭|返回|首页|设置|直播|收藏|历史|网盘|帮助|最大声|最小声)$/;

  var NAV = [['home', /^(回)?(到)?(首页|主页|主界面)$/], ['set', /^(打开|去|进入)?(设置|设定)(页|界面)?$/],
    ['live', /^(打开|去|进入|看)?(直播|电视直播|直播频道|频道列表)$/], ['fav', /^(打开|我的|去)?(收藏|收藏夹|我的收藏)$/],
    ['hist', /^(打开|我的|去)?(历史|观看历史|观看记录|播放记录|历史记录)$/],
    ['drive', /^(打开|我的|去)?(网盘|云盘|我的网盘|我的云盘)$/],
    ['search', /^(打开|去|进入)?(搜索|搜索页|搜索界面)$/]];

  function I(intent, arg, extra) {
    var r = { intent: intent, arg: arg || null };
    if (extra) for (var k in extra) if (extra.hasOwnProperty(k)) r[k] = extra[k];
    return r;
  }

  /* ================= 主解析 ================= */
  /* ctx: { player: 播放器是否打开 } —— 只影响"播放/暂停"是控制还是搜片 */
  function parse(text, ctx) {
    var c = ctx || {};
    var s = norm(text);
    var raw = String(text === null || text === undefined ? '' : text).trim();
    if (!s) return I('unknown', { reason: 'empty' }, { text: '' });

    var out;
    /* 0 帮助 */
    if (/^(帮助|你能做什么|能干什么|怎么用|有什么功能|你会什么|使用说明|帮助一下)$/.test(s)) return I('help', null, { text: s });

    /* 1 静音类(先于音量,否则"取消静音"会被当成加音量) */
    if (/(取消静音|关闭静音|解除静音|恢复声音|打开声音|取消无声)/.test(s)) return I('volume', { mode: 'unmute' }, { text: s });
    if (/(静音|闭嘴|别出声|不要声音|关掉声音)/.test(s)) return I('volume', { mode: 'mute' }, { text: s });

    /* 2 音量 */
    var hasVolWord = /(音量|声音|响声|声儿|最大声|最小声)/.test(s);
    if (hasVolWord || /(大点声|小点声|大声点|小声点|太响|太吵)/.test(s)) {
      if (/(最大|最响|全开)/.test(s)) return I('volume', { mode: 'set', value: 1 }, { text: s });
      if (/(最小|最低|调到最小)/.test(s)) return I('volume', { mode: 'set', value: 0 }, { text: s });
      /* "百分之八十"要先摘掉"百分之",否则会被当成一个"百"字 */
      var pct = /(百分之|%)/.test(s);
      var sVol = s.replace(/百分之/g, '');
      var vm = sVol.match(/(\d+(?:\.\d+)?|[零一二三四五六七八九十百两]{1,4})/);
      if (vm) {
        /* 中文数字容易误伤("大一点"里的"一"):要求前文有设定语义,阿拉伯数字不受此限 */
        var isCn = /[零一二三四五六七八九十百两]/.test(vm[1]);
        var lead = sVol.slice(0, vm.index);
        var settingCtx = !isCn || /(调到|调成|调至|设成|设为|到|为|音量|声音)$/.test(lead);
        var v = settingCtx ? cn2num(vm[1]) : NaN;
        if (!isNaN(v)) {
          if (pct || v > 1) v = v / 100;
          return I('volume', { mode: 'set', value: Math.max(0, Math.min(1, v)) }, { text: s });
        }
      }
      if (/(大|高|加|增|响|升)/.test(s)) return I('volume', { mode: 'up' }, { text: s });
      if (/(小|低|减|降|轻)/.test(s)) return I('volume', { mode: 'down' }, { text: s });
      /* 只说"音量"两个字,分不清要加减,交给面板追问 */
      return I('unknown', { reason: 'volume_ambiguous' }, { text: s });
    }

    /* 3 倍速 */
    if (/(倍速|几倍|速度|倍)/.test(s) || /(加快|减慢|放慢|加速|慢放)/.test(s)) {
      var rm = s.match(/(\d+(?:\.\d+)?|[零点一二三四五六七八九十两]{1,4})\s*倍/);
      if (rm) {
        var rate = cn2num(rm[1]);
        if (!isNaN(rate) && rate > 0.1 && rate <= 10) return I('rate', { value: rate }, { text: s });
      }
      if (/(正常|原速|常速|复位|恢复)/.test(s)) return I('rate', { value: 1 }, { text: s });
      if (/(加快|加速|快一点|快些)/.test(s)) return I('rate', { mode: 'faster' }, { text: s });
      if (/(减慢|放慢|慢一点|慢些|减速)/.test(s)) return I('rate', { mode: 'slower' }, { text: s });
    }

    /* 4 切集:先说集号,再说下一集/上一集 */
    var em = s.match(/第\s*([0-9零一二三四五六七八九十百两]{1,5})\s*[集话回期]/);
    if (em) {
      var ep = cn2num(em[1]);
      if (!isNaN(ep) && ep >= 1) return I('ep', { n: ep }, { text: s });
    }
    var em2 = s.match(/(跳到|切到|播到|看|播|放)\s*([0-9零一二三四五六七八九十百两]{1,5})\s*[集话回期]/);
    if (em2) {
      var ep2 = cn2num(em2[2]);
      if (!isNaN(ep2) && ep2 >= 1) return I('ep', { n: ep2 }, { text: s });
    }
    if (/(下一集|下集|下一个|下一话|再下一集|换一集|下一部)/.test(s)) return I('next', null, { text: s });
    if (/(上一集|上集|上一个|上一话|前一集|回上一集|上一部)/.test(s)) return I('prev', null, { text: s });

    /* 5 进度 */
    var sm = s.match(/(快进|前进|往前|跳过|往前跳|快退|后退|倒退|往回|往回倒)\s*(?:到)?\s*(\d+|[零一二三四五六七八九十百两]{1,5})\s*(秒|分钟|分)?/);
    if (sm && sm[2]) {
      var sec = cn2num(sm[2]);
      if (!isNaN(sec)) {
        if (sm[3] === '分钟' || sm[3] === '分') sec = sec * 60;
        var back = /(快退|后退|倒退|往回)/.test(sm[1]);
        return I('seek', { sec: back ? -sec : sec }, { text: s });
      }
    }
    if (/(快进|前进|往前跳)/.test(s)) return I('seek', { sec: 10 }, { text: s });
    if (/(快退|后退|倒退|往回倒)/.test(s)) return I('seek', { sec: -10 }, { text: s });
    if (/(从头|重新开始|重播|回到开头)/.test(s)) return I('restart', null, { text: s });

    /* 6 播放控制 */
    if (/(暂停|停一下|停止播放|别放了|先停)/.test(s)) return I('pause', null, { text: s });
    if (/(继续|接着放|接着播|恢复播放|放吧|开始播放)/.test(s)) return I('play', null, { text: s });

    /* 7 画面 / 退出 */
    if (/(退出全屏|取消全屏|小屏)/.test(s)) return I('fs', null, { text: s });
    if (/(全屏|满屏|放大画面)/.test(s)) return I('fs', null, { text: s });
    if (c.player && /(退出播放|关闭播放|关掉播放|退出播放器|退出去|退出|关闭|关掉)/.test(s)) return I('exit', null, { text: s });

    /* 8 返回 / 导航 */
    if (/^(返回|后退|回去|返回上一页|上一页)$/.test(s)) return I('back', null, { text: s });
    for (var n = 0; n < NAV.length; n++) {
      if (NAV[n][1].test(s)) return I('nav', { page: NAV[n][0] }, { text: s });
    }

    /* 9 播放器内的裸"播放/继续" */
    if (c.player && /^(播放|继续播放|放)$/.test(s)) return I('play', null, { text: s });
    if (CTRL_ONLY.test(s)) return I('unknown', { reason: 'no_player_action' }, { text: s });

    /* 10 兜底当搜索:去动词后剩下的当片名(单字不可靠,不做搜索) */
    var title = stripToTitle(s);
    if (title && title.length >= 2 && !CTRL_ONLY.test(title)) return I('search', { wd: title }, { text: s });

    return I('unknown', { reason: 'no_match' }, { text: s });
  }

  /* ================= 结果回显 ================= */
  /* 面板上显示"我理解成了什么",让用户能一眼发现误判 */
  function describe(r) {
    if (!r) return '';
    switch (r.intent) {
      case 'search': return '搜索:' + r.arg.wd;
      case 'play': return '继续播放';
      case 'pause': return '暂停';
      case 'next': return '下一集';
      case 'prev': return '上一集';
      case 'ep': return '第 ' + r.arg.n + ' 集';
      case 'seek': return (r.arg.sec > 0 ? '快进 ' : '后退 ') + Math.abs(r.arg.sec) + ' 秒';
      case 'restart': return '从头播放';
      case 'volume':
        if (r.arg.mode === 'mute') return '静音';
        if (r.arg.mode === 'unmute') return '取消静音';
        if (r.arg.mode === 'set') return '音量 ' + Math.round(r.arg.value * 100) + '%';
        return r.arg.mode === 'up' ? '音量 +' : '音量 -';
      case 'rate': return r.arg.value ? r.arg.value + ' 倍速' : (r.arg.mode === 'faster' ? '加速' : '减速');
      case 'fs': return '全屏切换';
      case 'exit': return '退出播放';
      case 'back': return '返回';
      case 'nav': return '打开 ' + ({ home: '首页', set: '设置', live: '直播', fav: '收藏', hist: '历史', drive: '网盘', search: '搜索' }[r.arg.page] || r.arg.page);
      case 'help': return '语音说明';
      default: return '';
    }
  }

  var VoiceNLU = { parse: parse, describe: describe, cn2num: cn2num, stripToTitle: stripToTitle, norm: norm };
  root.VoiceNLU = VoiceNLU;
  if (typeof module !== 'undefined' && module.exports) module.exports = VoiceNLU;
})(typeof window !== 'undefined' ? window : globalThis);
