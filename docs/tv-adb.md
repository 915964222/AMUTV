# 电视端 adb 调试环境（Windows / Git Bash）

本文只解决一件事：**在这个环境里 adb 会"点了没反应"**。结论是这不是 App 的 bug，是 adb server 被回收导致设备处于 `offline` 时 input 事件被静默丢弃。

## 症状

- 每条命令输出开头都有 `* daemon not running; starting now at tcp:5037`；
- `adb devices` 显示 `emulator-5554  offline`；
- `adb shell input tap X Y` 返回 0（成功），但界面纹丝不动；
- 换几个坐标都不生效，看起来像"应用自绘控件点不动"（其实换成手势/Focus 导航也一样无效）。

## 根因

| 层级 | 现象 | 说明 |
|---|---|---|
| 沙盒 | 每条 bash 命令结束后回收该命令派生的进程 | `adb server` 是 `adb` 客户端 fork 出来的守护进程，跟着被回收 |
| adb | 下一条命令冷启动 server | 冷启动瞬间设备尚未完成握手，状态为 `offline` |
| 设备 | offline 状态下 `input` 事件被丢弃 | 命令照样返回 0，**不报错**，最难排查 |

所以问题不是"坐标不对"，而是"事件根本没送到设备"。

## 修复（已落地）

两个脚本，都在 `tools/` 下：

### 1. `tools/adb-keepalive.sh` — 让 server 常驻

作为**后台任务**跑起来（不是 `nohup ... &`，沙盒会连后台派生一起回收）：

```bash
bash tools/adb-keepalive.sh      # 用后台任务方式启动
```

它每 3 秒做三件事：`adb start-server`（不在就拉起）、`adb reconnect offline`、`adb connect 127.0.0.1:5555`（雷电的第二个入口）。状态变化写 `build/adb-keepalive.log`。

效果：`adb.exe` 的 PID 跨多条命令保持不变（实测 `63512` 连续三次不变），不再出现 `daemon not running`。

### 2. `tools/tv.sh` — 统一入口，杜绝裸 adb

```bash
bash tools/tv.sh status                  # 看 server / 设备
bash tools/tv.sh ready                   # 等设备就绪(自动起 server + reconnect)
bash tools/tv.sh shot home               # 截图 → build/home.png
bash tools/tv.sh tap 2461 68             # 点击(设备真实坐标 2560x1440)
bash tools/tv.sh key KEYCODE_ESCAPE 2    # 按键,可重复次数
bash tools/tv.sh swipe 300 1300 300 500 400
bash tools/tv.sh start                   # 拉起 App
bash tools/tv.sh restart                 # force-stop 后重拉
bash tools/tv.sh install                 # 覆盖安装 amutv.apk
bash tools/tv.sh sh "curl -s http://127.0.0.1:9978/..."   # 设备内 shell
bash tools/tv.sh raw devices             # 直通 adb
```

每条命令内部都做 `ensure_ready`：`start-server` → 轮询 `get-state` 直到 `device`（默认 30s）→ 期间对 `offline` 自动 `reconnect` 并补连 `127.0.0.1:5555`。所以**即使保活没跑，脚本也不会在 offline 上白点**。

## 脚本里另外两个坑（顺带修掉）

1. **MSYS 路径转换**：`adb shell screencap -p /sdcard/x.png` 会被 Git Bash 改写成 `C:/Program Files/Git/sdcard/x.png`，命令返回 0 但文件不存在。
   → 脚本统一 `export MSYS_NO_PATHCONV=1`、`export MSYS2_ARG_CONV_EXCL='*'`；手动执行时也要带上。
2. **`adb pull` 的目标路径**：`adb.exe` 是原生程序，不认 MSYS 的 `/c/Users/...`，必须转成 `C:\Users\...`。
   → 脚本内用 `cygpath -w` 转换（`winpath()`）。

## 模拟器本身

```bash
cd /d/leidian/LDPlayer9 && ./dnplayer.exe index=0     # 启动雷电 index=0
```

冷启动到 `adb devices` 出现 `device` 大约 60s，`tv.sh ready` 会等。设备长期不用会被模拟器挂起，表现为 `offline`，`reconnect` 即可恢复。

## 排查口诀

> 点不动先看 `adb devices` 是不是 `device`。不是 → 环境问题；是 → 才怀疑坐标 / 焦点 / 业务代码。

## 更可靠的一招:直接调 DOM(CDP)

在 TV 上靠 `input tap x y` 点网页元素有三个坑,踩过就会反复浪费时间:

1. 坐标要按 **2560×1440** 换算,而你看的截图是缩略图,目测必偏几十~上百像素 → 点空或点到隔壁按钮;
2. 元素在**滚动区外**时,`uiautomator dump` 里根本没有它的节点(`bounds=[0,0][0,0]` 或直接缺失);
3. `input` 事件偶发丢失,点了没反应还以为是业务 bug。

正确做法是走 **WebView 远程调试**(App 已 `setWebContentsDebuggingEnabled(true)`):

```bash
SOCK=$(adb shell cat /proc/net/unix | grep -o 'webview_devtools_remote_[0-9]*' | head -1)
adb forward tcp:9222 localabstract:$SOCK

node tools/cdp.js 'document.getElementById("top-set").click(); "ok"'
node tools/cdp.js 'document.getElementById("wifi-list").innerText'
node tools/cdp.js 'document.getElementById("wifi-scan").closest(".sec-card").scrollIntoView({block:"center"})'
```

`tools/cdp.js` 会自动连 `127.0.0.1:9222/json` 找到页面、发 `Runtime.evaluate`(带 `userGesture`,
所以 `click()` 能触发真实交互),把返回值按 JSON 打印。滚动、点击、读文本一次搞定,不依赖坐标。

### 配套:`tv.sh find` / `tv.sh tapfind`

只查原生层(系统权限弹窗、设置页按钮)时用这两个,它们会 dump UI 树并按 `text` 或 `#resource-id` 反查中心坐标:

```bash
bash tools/tv.sh find "#top-set"      # → 2476 69 [2432,24][2520,114] 设置 | top-set
bash tools/tv.sh tapfind "#wifi-scan" # 找到就点它的中心
```

`bounds=[0,0][0,0]` 表示元素在可视区外,滚一下再查。网页内部的元素优先用 CDP,更稳。
