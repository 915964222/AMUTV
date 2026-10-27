# 语音搜索与控制

一句话完成「找片」和「控片」。电视端没有键盘，遥控器输入片名要摁十几下方向键，语音是这类应用最划算的输入方式。

## 一、为什么必须走原生

`webkitSpeechRecognition` / `SpeechRecognition` 在 Android WebView 里**不存在**（Chromium 未内置语音服务，浏览器端实现也只支持 Chrome 桌面且有 Google 账号依赖）。所以识别必须在 Java 侧做，再回传给网页：

```
用户说话
   ↓
Android  SpeechRecognizer(zh-CN，支持 partialResults)
   ↓  window.__onVoice({type,text,msg})
js/voice.js       面板 UI、状态机、执行
   ↓  parse()
js/voice-nlu.js   纯函数意图解析(可单测)
   ↓  exec()
Player.ctrl(rcExec)  /  AppCtl.search|go
```

原生侧要点（`android/MainActivity.java`）：

- `SpeechRecognizer.createSpeechRecognizer()` **不弹系统界面**，面板是我们自绘的，TV 上视觉统一
- `EXTRA_LANGUAGE = "zh-CN"`：盒子上系统语言常是英文，不指定会把中文识别成乱码
- `EXTRA_PARTIAL_RESULTS = true`：边说边出字，用户能立刻看到"识别到了"而不是干等
- Android 11+ 必须在 `<queries>` 声明 `android.speech.RecognitionService`，否则 `isRecognitionAvailable()` 恒为 false
- 录音权限运行时申请（`RECORD_AUDIO`），拒绝后明确回错，不退化成"没反应"

## 二、支持的说法

| 类别 | 说法示例 | 实际动作 |
|---|---|---|
| 搜片 | 看庆余年 / 我想看繁花 / 帮我搜一下狂飙 / 搜索狂飙 / 大雄兔 | 跳搜索页并聚合搜索 |
| 控制 | 暂停 / 继续 / 接着放 / 下一集 / 上一集 / 换一集 | 播放或切集 |
| 选集 | 跳到第 5 集 / 播放第三集 / 看第十二集 | 跳当前线路第 N 集 |
| 进度 | 快进 30 秒 / 后退十秒 / 快进一分钟 / 从头播放 | 相对拖动 / 归零 |
| 音量 | 声音大一点 / 调小音量 / 音量调到 50 / 音量调到百分之八十 / 最大声 / 静音 / 取消静音 | 音量 ±10% 或指定值 |
| 倍速 | 1.5 倍速 / 两倍 / 0.5 倍速播放 / 正常速度 / 加快 / 放慢 | 设定或 ±0.25x |
| 画面 | 全屏 / 退出全屏 | 全屏切换 |
| 退出 | 退出播放 / 关闭 / 退出 | 关闭播放器 |
| 导航 | 首页 / 回到首页 / 打开设置 / 直播 / 我的收藏 / 观看记录 / 网盘 / 搜索 / 返回 | 切页 |
| 帮助 | 你能做什么 / 有什么功能 | 面板内展开说法列表 |

说法不必逐字一致：`我要看` `麻烦播放` `给我找` `看一下` 这类前缀会被剥掉，`吧 / 呢 / 啊 / 可以吗` 后缀会被忽略，中文数字和阿拉伯数字等价（`第5集` = `第五集`）。

## 三、几个容易踩的实现细节

**1. 小数点被当成句号**

文本归一化会删标点，`1.5 倍速` 先被拆成 `1 5` 再解析，结果变成 5 倍速。做法是归一化前把 `数字.数字` 里的点换成占位符，删完标点再还原。

**2. `百分之八十` 变成 100%**

数字正则里的「百」会被当成单位先匹配走。做法是先摘掉「百分之」，再取「八十」，并按百分比语义除 100。

**3. `声音大一点` 里的「一」是数字**

中文数字字符集在中文字符串里误伤率很高。加了约束：**中文数字**必须前面跟着「调到 / 调成 / 到 / 为 / 音量」这类设定语义才当数值；阿拉伯数字不受此限。

**4. 播放器会抢按键**

`playerKeys` 绑在 `document` 的 capture 阶段，语音面板打开时按方向键会同时触发快进。处理：`playerKeys` 开头直接 `if (document.querySelector('.vc-mask')) return`。返回键则由面板在 capture 阶段 `stopImmediatePropagation` 拦截，先于播放器和路由。

**5. 面板复用弹窗体系**

面板根节点带 `.modal-mask`，于是 `goBack()`、`app.js` 的返回键分支、`KeyNav.setModal()` 全都自动生效，安卓物理返回键也能直接关面板。

## 四、设备没有识别服务时（三层回退）

原生侧 `startVoice()` 不只看 `isRecognitionAvailable()`，而是依次尝试三条通路：

| 顺序 | 通路 | 说明 |
|---|---|---|
| 1 | `SpeechRecognizer`（应用内识别） | 标准 RecognitionService，`partialResults` 流式出字，不弹系统界面 |
| 2 | `ACTION_RECOGNIZE_SPEECH` 外部界面 | 设备没注册 RecognitionService、但装了厂商语音 App（不少国产 TV 盒子如此）时，拉起它的识别界面，用 `onActivityResult` 取回文字 |
| 3 | 都没有 | 回调明确原因，面板直接展开键盘输入框 |

三条都不通时，提示文案会区分具体原因（`没装识别服务` / `缺中文语言包` / `没权限` / `连不上` / `麦克风不可用`），而不是笼统一句「识别失败」。

**识别器实例失效**（`ERROR_CLIENT`，常见于应用被切到后台再回来）：释放并重建一次再重试。不重建的表现是「点了麦克风毫无反应」——`startListening` 静默不回调。

**语言回退**：`zh-CN` → `zh` → `cmn-Hans-CN` → 系统默认。盒子上的识别服务常常只认其中一种，写死 `zh-CN` 会直接 `ERROR_LANGUAGE_NOT_SUPPORTED`。

### 体检：先看诊断，再判断是不是设备问题

面板底部「诊断」按钮，或代码里 `Voice.diag()` / `YSTV.voiceInfo()`：

```json
{"api":28,"model":"PHZ110","hasRec":false,"hasMic":true,"perm":true,
 "hasExtApp":false,"lang":"zh-CN","services":[]}
```

- `hasRec=false` + `services=[]` → 设备根本没有识别服务，装识别类 App 或直接用键盘
- `hasRec=true` + `perm=false` → 只是没给录音权限
- `hasMic=false` → 盒子没麦克风（`<uses-feature microphone required="false">`，不挡安装）
- `hasExtApp=true` → 会走通路 2，此时可能弹系统识别界面，属正常

## 五、遥控器怎么唤出

按键在 `MainActivity.dispatchKeyEvent` 拦截（WebView 会先吃掉按键，必须在 Activity 层拦）：

| 按键 | 说明 |
|---|---|
| `KEYCODE_SEARCH`(84) | 遥控器搜索键，实测可用 |
| `KEYCODE_VOICE_ASSIST`(231) | 遥控器语音键；部分 ROM 被系统助手先接管，收不到属正常 |
| 长按 `KEYCODE_MENU`(82) 550ms | 兜底入口；**长按信号在 `ACTION_DOWN` 的 repeat 事件上**（`repeatCount≥1` / `isLongPress`），只在 `ACTION_UP` 判时长会漏 |

面板已打开时再按一次 = 重新说。

## 六、调试

网页控制台 / CDP：

```js
Voice.parse('快进30秒')     // {intent:'seek', arg:{sec:30}}
Voice.say('下一集')         // 直接走完整链路(解析 + 执行)
Voice.start()               // 呼出面板走麦克风
Voice.diag()                // 语音体检
```

命令行（设备端）：

```bash
bash tools/adb-eval.sh "JSON.stringify(Voice.parse('音量调到百分之八十'))"
bash tools/adb-eval.sh "JSON.parse(YSTV.voiceInfo())"     # 体检原始数据
bash tools/adb-eval.sh --file tools/voice-check.js        # 模块/面板/解析/诊断一次跑完
/d/leidian/LDPlayer9/adb.exe -s emulator-5554 shell input keyevent --longpress 82   # 模拟长按 MENU
```

## 七、回归自测

```bash
node tools/voice-nlu-test.js
```

覆盖 68 条断言：搜片（8）、播放控制（11）、进度（6）、音量（10）、倍速（6）、导航（9）、上下文与边界（6）、中文数字（10）。全部 PASS 才算通过。

## 八、已知限制

- **依赖系统识别服务**：设备需装有语音识别服务（Google 语音服务、厂商自带或第三方识别 App）。国产盒子多数有厂商识别，纯 AOSP 模拟器没有
- **多数实现需要联网**：识别在服务端完成，断网时只能报错
- **单指令**：「暂停然后快进」只执行第一条
- **没有模型泛化**：说法表外的表达会走到搜索兜底，可能把整句话当片名
- **同音字靠搜索兜底**：识别成「庆于年」时按字面搜索，聚合搜索的拼音匹配会捞回来一部分，但不是精确纠正
- **真机拾音未验证**：开发环境是 LDPlayer 模拟器（Android 9 / API 28），系统里没有 RecognitionService，因此只验证到「按钮 → 原生调用 → 回调 → 回退/提示」这条完整链路，以及按键唤出、诊断、键盘输入。**麦克风实际拾音出字需在真机或盒子上确认**，先用「诊断」按钮看 `hasRec`：
  - `false` → 是设备环境问题，不是代码问题，装识别 App 或换设备
  - `true` 但仍不出字 → 看错误文案：缺权限 / 连不上 / 麦克风不可用，按提示处理
