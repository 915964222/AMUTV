# 遥控器「返回」键：层级设计与踩过的坑

电视 App 的返回键是最容易被忽略、又最容易让人以为「应用坏了」的地方。
本文记录本项目返回键的完整分层、原生与网页怎么配合，以及三个真实踩过的坑。

## 一、调用链

```
遥控器 KEYCODE_BACK
  → MainActivity.onBackPressed()
  → wv.evaluateJavascript("window.__onBack()")
  → app.js goBack() 返回 1（已处理）/ 0（没处理，可以退出）
  → 若 0：canGoBack() ? goBack() : 真正的 onBackPressed()
```

网页是**异步回话**的。如果 WebView 崩溃、或页面还没加载完，可能永远不回话 ——
这会表现成「返回键彻底没反应」。所以 `MainActivity` 里加了 **700ms 超时兜底**：
超时就走原生逻辑，宁可退出也不能让按键失灵。

## 二、层级（从内到外）

| 顺序 | 当前状态 | 返回动作 |
|---|---|---|
| 1 | 软键盘打开 | 收起键盘 |
| 2 | 播放器里有抽屉（选集/换源/字幕/弹幕/更多设置） | 关抽屉，**播放继续** |
| 3 | 播放器 | 关播放器，回到进入播放前的页面 |
| 4 | 弹窗（`.modal-mask`，如播放源管理） | 关弹窗 |
| 5 | 二级页（详情 / 分类） | 回到来源 tab |
| 6 | 非首页 tab（直播/网盘/收藏/历史/搜索/设置） | 回首页 |
| 7 | 已在首页 | 第一次提示「再按一次退出」，2 秒内再按才退出 |

第 7 层是专门为电视加的：遥控器误触率高，一按就退回桌面很容易让人以为应用崩了。

## 三、三个坑

### 1. 续播把整页清成 spinner，返回后成了永久转圈

```js
/* 错的写法 */
async function resumeHist(h) {
  view().innerHTML = UI.spinner();        // ← 清空整页只留一个转圈
  const d = await API.detailOf(src, h.vodId);
  playVod(...);                            // 播放器盖在上面，看不见下面的空白
}
```

播放器是**盖在页面之上的独立层**，用户看不到背后被清空的 `#view`。
一按返回关掉播放器，露出来的就是那个永远转圈的空白页 —— 看起来像「返回把 App 弄坏了」。

正确做法：**不要动当前页面**。加载期间弹个 toast，失败也留在原列表里。

保底还加了一层 `ensurePage()`：关闭播放器后若发现 `#view` 为空或只剩一个 `.spinner`，
按当前 tab 重画一次。以后任何路径再弄脏页面也能自愈。

### 2. 播放器抽屉开着时按返回，直接把整场播放退了

播放器内部的 Esc/Backspace 走自己的 `keydown`（会先 `closePanels()`），
但遥控器的返回键走的是原生 `onBackPressed` → `goBack()`，那条路原来是直接 `Player.close()`。

修法：`goBack()` 里先问一句 `Player.back()` —— 有抽屉就先关抽屉并返回 true。

### 3. 一按返回就退出应用

原来 `goBack()` 最后一层直接返回 `false`，原生就 `finish()`。
现改为两段式确认（见上表层 7），用 `lastBackAt` 记时间戳。

## 四、怎么验（不用手动按遥控器）

```bash
# 看网页侧的判定:1=网页已处理,0=可以退出
node tools/cdp.js 'window.__onBack()'

# 真按返回键
bash tools/tv.sh key 4

# 验完立刻查状态
node tools/cdp.js '(function(){return JSON.stringify({
  tab:(document.querySelector(".tab.on,.tab.active")||{}).textContent,
  player:document.querySelectorAll("#player").length,
  drawer:!!document.querySelector("#player .pl-drawer,#player .pl-strip"),
  viewHTML:(document.getElementById("view")||{}).innerHTML.slice(0,60)
});})()'
```

判断「白屏」的标准：`viewHTML` 只有 `<div class="spinner"></div>` 就是坏的那一种。

## 五、相关文件

| 文件 | 作用 |
|---|---|
| `android/MainActivity.java` `onBackPressed()` | 原生入口、700ms 超时兜底、防连按抖动 |
| `js/app.js` `goBack()` / `ensurePage()` | 层级判定、白屏自愈、首页二次确认 |
| `js/player.js` `back()` | 播放器抽屉优先关闭 |
| `js/app.js` `resumeHist()` | 历史续播不再污染 `#view` |
