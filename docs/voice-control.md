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

## 四、设备没有识别服务时（四层回退）

原生侧 `startVoice()` 不只看 `isRecognitionAvailable()`，而是依次尝试四条通路：

| 顺序 | 通路 | 说明 |
|---|---|---|
| 1 | `SpeechRecognizer`（应用内识别） | 标准 RecognitionService，`partialResults` 流式出字，不弹系统界面 |
| 2 | `ACTION_RECOGNIZE_SPEECH` 外部界面 | 设备没注册 RecognitionService、但装了厂商语音 App（不少国产 TV 盒子如此）时，拉起它的识别界面，用 `onActivityResult` 取回文字 |
| 3 | **自录音 + 云端 ASR** | 前两条都不通时，自己用 `AudioRecord` 录 16k/16bit 单声道 WAV，原生 multipart 上传给用户配置的识别接口。**只要麦克风能出声就能用**，见第九节 |
| 4 | 都没有 | 回调明确原因，面板直接展开键盘输入框 |

前端 `Voice.route()` 会返回当前生效的是哪条：`native` / `cloud` / `need-asr` / `none`。

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
- **拾音质量取决于硬件**：模拟器（LDPlayer / API 28）没有真实输入源，录音能正常落盘但数据全 0，会走「没听到声音」分支。真机上要确认的是**有没有麦克风**和**增益够不够**——峰值低于阈值（500/32767）会被当成静音，外接麦增益太小可能触发，换 `VOICE_RECOGNITION` 源或调 `VoiceRec.AMP_TH`。
- **云端识别要自己准备接口**：见下一节。

## 九、真实麦克风到底通不通用

先说结论：**只靠系统识别不通用；自录音 + 云端识别才通用。**

### 为什么「系统识别」不通用

`android.speech.SpeechRecognizer` 自己不识别，它只是去调设备上注册的 `RecognitionService`。国产电视盒子（小米/当贝/天猫魔盒等）绝大多数**没有 GMS，也没有对第三方开放的识别服务**。实测一台典型设备：

```json
{"api":28,"model":"PHZ110","hasMic":true,"perm":true,"hasRec":false,"hasExtApp":false,"services":[]}
```

`hasMic=true`、`perm=true`（麦克风好着、权限也给了），但 `services=[]`。**这时候插什么麦克风都没用** —— 缺的不是麦克风，是「把声音变成文字」的那一层。

还有一种更隐蔽的情况：盒子自带语音遥控器，但语音走的是厂商私有链路（遥控器 → 厂商服务），第三方 App 拿不到那条通道。

### 通用方案：自己录音，自己识别

```
麦克风(内置/USB/蓝牙麦)
   ↓  AudioRecord 16kHz / 16bit / mono
   ↓  VAD:说完静音 0.9s 自动收尾,最长 10s
   ↓  cacheDir/voice.wav  (+44 字节标准 WAV 头)
   ↓  原生 HttpURLConnection multipart 上传
云端 ASR  →  {text: "看庆余年"}
   ↓  pickText() 归一各家返回结构
同一套 NLU → 搜索/播放控制
```

这样设备有没有语音服务都无所谓，**只要有麦克风**。

### 为什么上传必须在原生做

App 页面是 `file:///android_asset/...`，往外部域名 POST 就是跨域请求：

- 自建网关一般会带 `Access-Control-Allow-Origin`，能通
- **官方 OpenAI / 讯飞 / 阿里云都不返回 CORS 头**，网页 `fetch` 必被 WebView 拦掉，报错还看不出是 CORS

所以 `VoiceAsr.java` 用 `HttpURLConnection` 拼 multipart 直传，绕开 CORS 与混合内容策略。浏览器环境（`webRecOk()`）仍保留 fetch 通路，供桌面调试。

### 怎么用

1. 语音面板 → 「识别服务」
2. 填接口地址。**兼容 OpenAI Whisper 形式**：`https://你的网关/v1/audio/transcriptions`
   - 自建代理到 OpenAI、one-api / new-api 之类的聚合网关都行
   - 国内厂商若有 multipart 上传接口，填它的地址 + Key 即可
3. 填 API Key（服务端不校验就留空）
4. 「保存并试用」→ 直接开始录音

配置存 `localStorage.vc_asr`，字段 `{url,key,model,lang}`。地址留空保存 = 清空配置，回到系统识别。

### 返回结构怎么兼容

`pickText()` 按语义键优先、大小写不敏感、最多递归 6 层找正文，并跳过 `code/msg/status/error` 这类噪声字段：

| 返回体 | 取到 |
|---|---|
| `{"text":"看庆余年"}` | 看庆余年 |
| `{"result":"下一集"}` | 下一集 |
| `{"data":{"text":"音量调到50"}}` | 音量调到50 |
| `{"Result":{"Text":"暂停"}}` | 暂停 |
| `{"code":0,"data":{"result":[{"sentence":"快进30秒"}]}}` | 快进30秒 |
| `{"code":1,"msg":"invalid key"}` | （空，走报错而不是把 "invalid key" 当指令） |
| 纯文本 `看繁花` | 看繁花 |

接口通了但「没字」时，`Voice.asrText(原始响应)` 可以直接看解析结果。

### 已验证 / 未验证

**已实测通过**（LDPlayer API 28，用 `tools/mock-asr.js` 做本地假接口）：

- 录音：`ms=1631, bytes=51200, silent=true`，WAV 头 `RIFF/16000/1ch/16bit/data=48000` 完全合规
- 上传：mock 收到 `51642B multipart=true RIFF=true` —— 音频确实被正确封装发出去了
- 解析 + 执行：识别文本回到前端 → NLU → 搜索页 13 条结果，面板自动关闭
- 静音场景：`peak=0` → 提示「没听到声音：麦克风没有信号」，不会把空音频发出去浪费请求
- 通路切换：`route()` 从 `need-asr` → 配好地址 → `cloud`

**未验证**：真实麦克风的拾音出字。模拟器没有真实输入源，`peak` 恒为 0。要在真机/盒子上确认：

```js
Voice.diag()      // 看 hasMic / perm / 云端识别是否已配置
Voice.route()     // cloud = 走云端识别
```

录完如果提示「没听到声音」，看是设备真没麦，还是增益太小（`peak` 有值但低于 500）。

### 本地假接口（不需要 Key 就能验证链路）

```bash
node tools/mock-asr.js                 # PC 上监听 127.0.0.1:9999
adb reverse tcp:9999 tcp:9999          # 设备上的 127.0.0.1:9999 转到这台电脑
# App「识别服务」填 http://127.0.0.1:9999/asr
```

固定返回「看庆余年」，日志会打印收到的字节数、是否 multipart、是否含 RIFF 头。
