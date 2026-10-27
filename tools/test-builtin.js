/* 源策略单测:用假 localStorage 跑 store.js,验证「爱奇艺内置 + 其余只保留」
   ① 全新安装 → 爱奇艺 builtIn=true(唯一内置),4 个 1080P 为普通预设源(可删)
   ② 老安装(上一版把 4 个 1080P 标成了 builtIn) → 自动降级为普通源,不产生重复
   ③ 老安装(只有爱奇艺) → 自动补齐 4 个预设源
   ④ 删掉预设源后不再自动加回;restorePreset1080 能补回且幂等
   ⑤ 带广告源(暴风)一律剔除
   运行: node tools/test-builtin.js */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'js', 'store.js'), 'utf8');

function makeDB(seed) {
  const store = Object.assign({}, seed || {});
  const localStorage = {
    getItem: k => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: k => { delete store[k]; },
  };
  const ctx = { localStorage, console, Date, Math, JSON, setTimeout, clearTimeout };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(src + '\n;globalThis.__DB = DB;', ctx);
  return { DB: ctx.__DB, store };
}
const maxLen = (arr) => arr.map(x => x.name).join('/');

let pass = 0, fail = 0;
const check = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✔ ' + name); }
  else { fail++; console.log('  ✖ ' + name + (extra ? '  → ' + extra : '')); }
};

console.log('① 全新安装');
{
  const { DB } = makeDB();
  const s = DB.getSources();
  check('源数量 = 5', s.length === 5, '实际 ' + s.length + ': ' + maxLen(s));
  check('唯一内置源是爱奇艺', s.filter(x => x.builtIn).length === 1 && s.find(x => x.builtIn).api.includes('iqiyizyapi'), maxLen(s.filter(x => x.builtIn)));
  check('4 个 1080P 为普通源(可删)', s.filter(x => x.tag === '1080P' && !x.builtIn).length === 4);
  check('含天涯/豪华', s.some(x => x.api.includes('tyyszy')) && s.some(x => x.api.includes('hhzyapi')));
  check('不含带广告的暴风', !s.some(x => x.api.includes('bfzyapi')));
}

console.log('② 老安装:上一版把 4 个 1080P 标成了内置');
{
  const seed = {
    tvw_sources: JSON.stringify([
      { id: 'iqiyi', name: '爱奇艺资源(内置)', api: 'https://iqiyizyapi.com/api.php/provide/vod', builtIn: true },
      { id: 'ffzy', name: '非凡资源(1080P)', api: 'https://api.ffzyapi.com/api.php/provide/vod/', builtIn: true, tag: '1080P' },
      { id: 'dytt', name: '电影天堂(1080P)', api: 'http://caiji.dyttzyapi.com/api.php/provide/vod/', builtIn: true, tag: '1080P' },
      { id: 'tyys', name: '天涯资源(1080P)', api: 'https://tyyszy.com/api.php/provide/vod/', builtIn: true, tag: '1080P' },
      { id: 'hhzy', name: '豪华资源(1080P)', api: 'https://hhzyapi.com/api.php/provide/vod/', builtIn: true, tag: '1080P' },
    ]),
  };
  const { DB } = makeDB(seed);
  const s = DB.getSources();
  check('总数仍 5(无重复)', s.length === 5, '实际 ' + s.length + ': ' + maxLen(s));
  check('4 条 1080P 全部降级为普通源', s.filter(x => x.tag === '1080P' && !x.builtIn).length === 4);
  check('只剩爱奇艺是内置', s.filter(x => x.builtIn).length === 1);
  check('原 id 未被改写', s.some(x => x.id === 'ffzy') && s.some(x => x.id === 'hhzy'));
  check('二次调用幂等', DB.getSources().length === 5);
}

console.log('③ 老安装:只有爱奇艺');
{
  const seed = {
    tvw_sources: JSON.stringify([
      { id: 'iqiyi', name: '爱奇艺资源(内置)', api: 'https://iqiyizyapi.com/api.php/provide/vod', builtIn: true },
    ]),
  };
  const { DB } = makeDB(seed);
  const s = DB.getSources();
  check('补齐到 5 条', s.length === 5, '实际 ' + s.length);
  check('补齐的也都是普通源', s.filter(x => x.builtIn).length === 1);
}

console.log('④ 删除后不回填 / 恢复按钮');
{
  const { DB } = makeDB();
  const target = DB.getSources().find(x => x.tag === '1080P');
  DB.removeSource(target.id);
  check('删除生效(剩 4 条)', DB.getSources().length === 4, '实际 ' + DB.getSources().length);
  check('再次 getSources 不自动加回', DB.getSources().length === 4, maxLen(DB.getSources()));
  const r1 = DB.restorePreset1080();
  check('恢复补回 1 条', r1.added === 1, JSON.stringify(r1));
  check('恢复后仍是普通源', !!DB.getSources().find(x => x.api === target.api && !x.builtIn));
  const r2 = DB.restorePreset1080();
  check('恢复幂等', r2.added === 0 && DB.getSources().length === 5, JSON.stringify(r2));
}

console.log('⑤ 带广告源剔除(含旧记录)');
{
  const seed = {
    tvw_sources: JSON.stringify([
      { id: 'iqiyi', name: '爱奇艺资源(内置)', api: 'https://iqiyizyapi.com/api.php/provide/vod', builtIn: true },
      { id: 'src_bf', name: '暴风资源(1080P)', api: 'https://bfzyapi.com/api.php/provide/vod/', builtIn: true, tag: '1080P' },
    ]),
  };
  const { DB, store } = makeDB(seed);
  const s = DB.getSources();
  check('暴风被移除', !s.some(x => x.api.includes('bfzyapi')), maxLen(s));
  check('记入已移除名单', (store.tvw_preset1080_removed || '').includes('bfzyapi'));
  check('其余 4 条补齐且非内置', s.length === 5 && s.filter(x => x.builtIn).length === 1, maxLen(s));
}

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
