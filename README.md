<div align="center">

# 📺 AMUTV — 类 TVBox 影视 TV(纯 Web)

![](https://img.shields.io/badge/应用-AMUTV-black) ![](https://img.shields.io/badge/形态-Web·桌面·安卓-blue) ![](https://img.shields.io/badge/依赖-Node.js%20零依赖-green) ![](https://img.shields.io/badge/采集-苹果CMS%20V10-orange) ![](https://img.shields.io/badge/直播-IPTV%20EPG-red) ![](https://img.shields.io/badge/渲染-HLS·MP4·4K-9cf)

一个纯网页版的「影视TV」,界面与交互对标电视盒子的 TVBox / 影视仓,**零 npm 依赖,`node server.js` 一条命令即跑**。

</div>

---

## ✨ 功能特性

### 🖥️ 大屏交互
- **纯黑海报墙主题**(Apple TV 风格):胶囊导航、横向海报滚动行、白色焦点环,适配遥控器与鼠标双操作
- **遥控器式导航**:方向键在卡片间移动焦点,Enter 确认,Esc/Backspace 返回;点击画面=暂停,双击=全屏

### 🗄️ 内容源
- **多仓 / 接口订阅**:URL 订阅或粘贴 TVBox 配置 JSON(单仓 `sites` / 多仓 `urls`·`storeHouse`),`clan://` 按仓库基址解析,爬虫类(type 3)源自动跳过,支持刷新/退订/源连通性测试(🟢🔴)
- **多源全网搜索**:并发池搜索全部源,按源分组展示耗时;支持**拼音/拼音首字母**(`dxt` → 大雄兔);结果可按**速度优先 / 清晰度优先**排序
- **手动/自动换源**:播放页「换源」面板列出其他源同名影片;播放失败或**卡顿超15秒**自动换源(最多3次,可关)

### 📺 直播 IPTV
- m3u / txt(含 `#genre#`、`$装饰后缀`)双格式解析,**同名频道多线路合并**容灾
- EPG 节目单(正在播/接下来,当天缓存),分组/频道懒加载,多源管理
- 播放卡壳自动切线路看门狗(45秒未出画自动换下一线路)

### ▶️ 播放器
- HLS(多码率画质锁档)/ MP4 直连,解码内核(自动/MSE/原生)与硬解/软解模式可切
- **倍速 0.5~3x、画面比例、画面缩放 100~130%、音轨、内嵌字幕、在线字幕**(SubHD 自动下载,偏移微调)
- **弹幕**:B站 XML 渲染器(滚动/顶/底、字号、透明度)+ 弹弹play 接口对接
- 片头/片尾标记与**自动跳过**,断点续播,卡顿三级看门狗(修复→切软解→换源)
- 去广告:m3u8 广告切片双层过滤(代理层 + hls.js loader 层)

### ☁️ 影视库扩展
- **网盘直连**:**Alist**(302 原画直链)、**WebDAV**、**SMB**(Windows 直读 UNC)、**阿里云盘**(官方扫码 OAuth)、**夸克**(Cookie)
- **海报墙刮削**:网盘视频文件自动刮削豆瓣海报/评分/简介/演员表,点击进详情页
- **NAS/本地**:蓝光原盘 `.m2ts/.ts` 按字节范围虚拟 VOD 流式播放(不整载内存);U盘即插即播
- **云盘 4K 识别**(2160/4K/uhd/大文件蓝徽章),网页型地址**智能嗅探**(`/sniff/` 转换代理 + 四路钩子抓直链)

### 📱 多端与周边
- **安卓 App**(`amutv.apk`,3.2MB):网页资源全内嵌 + MiniServer(9978)独立运行,**局域网浏览器访问 `http://<设备IP>:9978` 也能直接用**
- **桌面 App**(Electron):软解防闪退、崩溃自愈、错误落盘
- **PWA**:可安装到桌面/主屏幕,UI 骨架离线可用
- **手机遥控**:播放器二维码 → `/remote` 扫码遥控(seek/切集/音量);**扫码推送配置**导入源
- **本地代理**:`/proxy/` 转发接口/图片/视频流(跨域、防盗链、HTTP混合内容全解决;H2 优先、Range 拖动)

---

## 🚀 快速开始

| 方式 | 操作 |
|---|---|
| 📱 **安卓** | 安装根目录 `amutv.apk`,完全独立运行不依赖电脑 |
| 🖥️ **桌面** | 双击 `启动影视TV.bat`(Electron 壳自动拉起内嵌服务器) |
| 🌐 **浏览器** | `node server.js` → 打开 `http://localhost:9978`,支持 PWA 安装 |

局域网内电视/手机浏览器访问 `http://<电脑IP>:9978` 即可当电视应用用(安卓 App 同理,访问 `http://<手机IP>:9978`)。

## ⌨️ 快捷键

| 操作 | 按键 |
|---|---|
| 移动焦点 / 确认 / 返回 | ↑↓←→ / Enter / Esc·Backspace |
| 快进·快退 / 音量 / 暂停 | ←→(10秒) / ↑↓ / 空格 |
| 选集 / 全屏 / 嗅探 / 换源 / 下一集 | E / F / V / S / N |

## 🔧 添加采集源

「设置」→ 填名称 + 苹果CMS接口地址(如 `https://example.com/api.php/provide/vod/`)→ 添加后顶栏「播放源」切换。站点不开跨域头时保持**代理模式**开启即可。直播页同理可添加 m3u/txt 直播源。

## 📂 目录结构

```
tvbox-web/
├── index.html            入口
├── css/style.css         纯黑海报墙主题
├── server.js             静态服务 + 代理 + WebDAV/Alist + 嗅探 + 字幕/弹幕中转(零依赖)
├── electron-main.js      桌面版 Electron 壳
├── amutv.apk             安卓安装包(独立运行)
├── build-apk.bat         安卓打包脚本(工具链 %LOCALAPPDATA%\android-sdk-tmp)
├── prepare-assets.py     安卓资产拍平
├── js/
│   ├── store.js          本地数据(源/仓库/收藏/历史/网盘/标记)
│   ├── api.js            苹果CMS适配 + 搜索 + 换源 + 测源
│   ├── keynav.js         遥控器方向键焦点导航
│   ├── player.js         播放器(HLS/选集/续播/弹幕/字幕/换源)
│   ├── live.js           直播 IPTV(m3u/txt 解析 + EPG)
│   ├── cloud.js          云盘(阿里/夸克直链中转)
│   ├── scraper.js        豆瓣海报墙刮削
│   ├── danmaku.js        弹幕渲染器
│   ├── subtitle.js       本地字幕探测
│   ├── ad-rules.js       m3u8 广告过滤规则(双端共享)
│   ├── ui.js / app.js    通用组件 / 路由与页面
└── android/              安卓壳(MainActivity + MiniServer)
```

> ⚠️ **免责声明**:本软件只提供聚合展示功能,所有资源均来自互联网公开内容,软件不参与任何资源的制作、上传、储存与下载等内容。本软件仅供个人学习交流参考,请于安装后 24 小时内自行删除。
