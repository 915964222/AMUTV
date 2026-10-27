/* 语音意图解析回归自测(纯函数,不依赖设备/网络)
 * 运行: node tools/voice-nlu-test.js
 */
const NLU = require('../js/voice-nlu.js');

let pass = 0, fail = 0;
const fails = [];

function t(text, wantIntent, wantArg, ctx) {
  const r = NLU.parse(text, ctx);
  let ok = r.intent === wantIntent;
  if (ok && wantArg) {
    for (const k in wantArg) {
      if (JSON.stringify(r.arg && r.arg[k]) !== JSON.stringify(wantArg[k])) { ok = false; break; }
    }
  }
  const label = '"' + text + '" → ' + wantIntent + (wantArg ? ' ' + JSON.stringify(wantArg) : '');
  if (ok) { pass++; console.log('  PASS ' + label + '  [' + NLU.describe(r) + ']'); }
  else { fail++; fails.push(label + '  实际: ' + r.intent + ' ' + JSON.stringify(r.arg)); console.log('  FAIL ' + label + '  实际: ' + r.intent + ' ' + JSON.stringify(r.arg)); }
}

const P = { player: true };

console.log('\n[1] 搜片');
t('看庆余年', 'search', { wd: '庆余年' });
t('我想看繁花', 'search', { wd: '繁花' });
t('帮我搜一下狂飙', 'search', { wd: '狂飙' });
t('播放三体', 'search', { wd: '三体' });
t('搜索狂飙', 'search', { wd: '狂飙' });
t('大雄兔', 'search', { wd: '大雄兔' });
t('看一下流浪地球吧', 'search', { wd: '流浪地球' });
t('给我找一部喜剧片', 'search', { wd: '一部喜剧片' });

console.log('\n[2] 播放控制(播放器内)');
t('暂停', 'pause', null, P);
t('继续', 'play', null, P);
t('接着放', 'play', null, P);
t('下一集', 'next', null, P);
t('上一集', 'prev', null, P);
t('换一集', 'next', null, P);
t('跳到第5集', 'ep', { n: 5 }, P);
t('播放第三集', 'ep', { n: 3 }, P);
t('看第十二集', 'ep', { n: 12 }, P);
t('从头播放', 'restart', null, P);
t('退出播放', 'exit', null, P);
t('退出', 'exit', null, P);
t('全屏', 'fs', null, P);

console.log('\n[3] 进度');
t('快进30秒', 'seek', { sec: 30 }, P);
t('快退十秒', 'seek', { sec: -10 }, P);
t('快进一分钟', 'seek', { sec: 60 }, P);
t('后退两分钟', 'seek', { sec: -120 }, P);
t('快进', 'seek', { sec: 10 }, P);
t('往回倒5秒', 'seek', { sec: -5 }, P);

console.log('\n[4] 音量');
t('声音大一点', 'volume', { mode: 'up' }, P);
t('大点声', 'volume', { mode: 'up' }, P);
t('调小音量', 'volume', { mode: 'down' }, P);
t('音量调到50', 'volume', { mode: 'set', value: 0.5 }, P);
t('音量五十', 'volume', { mode: 'set', value: 0.5 }, P);
t('音量调到百分之八十', 'volume', { mode: 'set', value: 0.8 }, P);
t('最大声', 'volume', { mode: 'set', value: 1 }, P);
t('最小声', 'volume', { mode: 'set', value: 0 }, P);
t('静音', 'volume', { mode: 'mute' }, P);
t('取消静音', 'volume', { mode: 'unmute' }, P);

console.log('\n[5] 倍速');
t('1.5倍速', 'rate', { value: 1.5 }, P);
t('两倍', 'rate', { value: 2 }, P);
t('正常速度', 'rate', { value: 1 }, P);
t('加快', 'rate', { mode: 'faster' }, P);
t('放慢', 'rate', { mode: 'slower' }, P);
t('0.5倍速播放', 'rate', { value: 0.5 }, P);

console.log('\n[6] 导航');
t('首页', 'nav', { page: 'home' });
t('回到首页', 'nav', { page: 'home' });
t('打开设置', 'nav', { page: 'set' });
t('直播', 'nav', { page: 'live' });
t('我的收藏', 'nav', { page: 'fav' });
t('观看记录', 'nav', { page: 'hist' });
t('网盘', 'nav', { page: 'drive' });
t('搜索', 'nav', { page: 'search' });
t('返回', 'back');

console.log('\n[7] 上下文与边界');
t('播放', 'play', null, P);
t('播放', 'unknown', { reason: 'no_player_action' }, { player: false });
t('看', 'unknown', null, {});
t('', 'unknown', { reason: 'empty' }, {});
t('你能做什么', 'help');
t('音量', 'unknown', { reason: 'volume_ambiguous' }, P);

console.log('\n[8] 中文数字');
const nums = [['十', 10], ['十五', 15], ['二十', 20], ['二十五', 25], ['一百', 100], ['一百二十', 120], ['三十五', 35], ['3', 3], ['1.5', 1.5], ['三点五', 3.5]];
nums.forEach(([s, want]) => {
  const got = NLU.cn2num(s);
  if (got === want) { pass++; console.log('  PASS ' + s + ' = ' + got); }
  else { fail++; fails.push('cn2num(' + s + ') 期望 ' + want + ' 实际 ' + got); console.log('  FAIL ' + s + ' 期望 ' + want + ' 实际 ' + got); }
});

console.log('\n结果: ' + pass + ' 通过 / ' + fail + ' 失败');
if (fail) { console.log('\n失败明细:'); fails.forEach(f => console.log(' - ' + f)); process.exit(1); }
