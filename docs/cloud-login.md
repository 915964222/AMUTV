# 云盘登录:链路、三种入口、以及「扫了登不上」的唯一原因

## 一、扫码链路(每一段都可单独验证)

```
电视面板 /cloud/ali/qr  ──POST──> aliyundrive-oauth.messense.me/oauth/authorize/qrcode
        ↓ 返回 { sid, qrCodeUrl }
   本地 qrcode 库把 qrCodeUrl 画成二维码(不依赖第三方图床)
        ↓ 手机扫码
   每 2.5s: /cloud/ali/poll?sid=xxx ──GET──> openapi.alipan.com/oauth/qrcode/{sid}/status
        ↓ status 变化:WaitLogin → ScanSuccess → LoginSuccess(+authCode)
   /cloud/ali/token 用 authCode 换 refresh_token → 存 DB.config.clouds[].refresh_token
        ↓
   Cloud.browse('root') 读列表(openFile/list) → 网盘页
```

各段自测命令(设备上执行):

```bash
curl -s -X POST http://127.0.0.1:9978/cloud/ali/qr                  # 取码
curl -s "http://127.0.0.1:9978/cloud/ali/poll?sid=<sid>"             # 状态
curl -s -o /dev/null -D - "https://openapi.alipan.com/oauth/qrcode/<sid>"   # 看响应类型
```

## 二、「扫了也登不了」= 99% 是用错了 App

关键事实:**`qrCodeUrl` 是一个普通网址,直接 HTTP 打开返回的是 `image/jpeg`**。

```
GET https://openapi.alipan.com/oauth/qrcode/1793093865...
→ 200 OK, Content-Type: image/jpeg, 58KB
```

所以:

| 用什么扫 | 手机上看到 | 结果 |
|---|---|---|
| **阿里云盘 App → 扫一扫** | 「确认登录」按钮 | ✅ 能登录 |
| 相机 / 微信 / 相册 / 系统扫一扫 | **一张二维码图片**,顶部一串 `1793…` 编号(其实是 sid 当文件名) | ❌ 永远登不上,页面上没有确认按钮 |

判定方法:手机浏览器地址栏/标题栏里那串以 `1793093xxx` 开头的编号,前 10 位是毫秒时间戳,
能对上你扫码那一刻 —— 说明手机只是把二维码里的 URL 当网页打开了,`/status` 会一直停在 `WaitLogin`。

代码侧为此做的三件事(2026-10-27):

1. 面板加**醒目黄框**说明「只认 App 里的扫一扫」,不再是一行灰色小字。
2. 出码 **25 秒仍未扫上** → 自动弹出针对性诊断(「你看到的是不是一张图片?」)。
3. 二维码 **可点击放大**(288 → 420px),电视离沙发两三米也能对焦。

## 三、另外两个曾经导致「扫不上」的时序坑

| 坑 | 现象 | 现在 |
|---|---|---|
| 码 120 秒就自动换 | 用户还在找手机/开 App,码已经换了,手机上直接报「二维码已失效」 | 改到 **168 秒**(官方 180 秒过期)再换 |
| 已扫码还在换码 | 手机点了「确认登录」,但这个 sid 已被新码顶掉 | **一旦 `ScanSuccess` 就不再换码** |

旧码不会立刻丢弃:`QR_KEEP`(=210 秒)内继续轮询,出现在旧码上确认也能登录。

## 四、三条登录入口

| 入口 | 适合谁 | 说明 |
|---|---|---|
| 阿里扫码 | 手机上有阿里云盘 App | 默认入口,上面的坑都在这里 |
| **refresh_token** | 没装 App / 想长期稳定 | 面板底部「扫码一直不行?改用 refresh_token 登录」。保存前会用 `/cloud/ali/refresh` 验证,并当场读一次根目录,成功显示「登录成功 ✓ 根目录 N 项」 |
| 夸克 Cookie | 夸克网盘用户 | 电脑浏览器 F12 复制完整 Cookie(需含 `__pus` 与 `__puus`)。**夸克扫码入口已移除**(体验不稳定,协议分析留在第五节) |

### 拿 refresh_token 的两个办法

1. 电脑浏览器登录 `www.alipan.com` → F12 → Application → Local Storage → 键 `token` → 里面 JSON 的 `refresh_token`。
2. 用 `aliyundrive-webdav` 自带的 token 工具。

> 阿里 refresh_token **一次一换**,旧的用一次就作废。`Cloud.aliToken()` 拿到新的会回写
> `DB.config.clouds`,否则隔天就是 `RefreshTokenInvalid`。手工粘贴时同理,要存最新的那条。

## 五、登录之后仍然空白?查这两处

- 列表结构:`openFile/list` 返回 `{items:[{file_id,name,type,size}]}`,不是 `{list}`,也没有 `fid/dir`。
  读错就是「登录成功但一片空白」。映射在 `Cloud.browse()`。
- 错误体:阿里返回 `{code,message,requestId}`,只判 `r.error` 会把 401 当成空目录。
  `mustOk()` 负责把真实错误码抛给界面。

## 五、夸克扫码(UC 系 cas)——已从前端下线,协议留档

> 2026-10-27:扫码入口已移除,夸克登录只保留 Cookie 方式。原因:确认页停留期间
> 票据(实测 TTL≈180s)仍可能过期,真机两次扫码都折在时序上,体验不稳。
> 后端 `/cloud/quark/qr|poll|st` 三个端点保留(仅 127.0.0.1 可达),想恢复可参照本节。

```
/cloud/quark/qr    → GET  https://uop.quark.cn/cas/ajax/getTokenForQrcodeLogin?client_id=532&v=1.2
                   ← {"status":2000000,"data":{"members":{"token":"sta..."}}}
二维码内容         → https://su.quark.cn/4_eMHBJ?token=<token>&client_id=532   (App 唤起链接,不是网页)

/cloud/quark/poll?token=  → GET https://uop.quark.cn/cas/ajax/getServiceTicketByQrcodeToken
                                ?client_id=532&v=1.2&token=<token>
                   ← 50004001 Query result is empty           未扫码
                   ← 2000000 + data.members.service_ticket     已确认
                   ← 50004003                                  已扫码待确认
                   ← 50004002                                  码已过期

/cloud/quark/st?st=  → GET https://pan.quark.cn/account/info?st=<ticket>&lw=scan
                   ← Set-Cookie: ctoken=...; __puus=...        → 拼成 cookie 存进 DB
```

三个必须知道的事实:

1. **`status` 是数字**,不是阿里那种字符串;`2000000` 才是成功,别用 `=== 'ok'` 之类去判。
2. **`__puus` 只在 `Set-Cookie` 里**,网页 `fetch` 永远读不到(即使 CORS 通了也拿不到 Set-Cookie)。
   所以兑换那一步必须原生走 —— 这就是 `/cloud/quark/st` 存在的唯一理由,它同时收集沿途所有 cookie,
   只存 `__puus` 会缺 `ctoken`。
3. 兑换请求要**关掉自动跟随跳转**(`setInstanceFollowRedirects(false)`)自己跟,
   否则中途 302 响应里的 `Set-Cookie` 会被 HttpURLConnection 吞掉。
4. **票据 TTL 实测 ≈180 秒**(无人扫,171s 仍 50004001、183s 变 50004002)。
   电视端 `QK_LIFE=120` 秒主动换新码,留 60s 余量 —— 用户压着生命周期末端扫,
   手机确认页也有足够时间点「确认登录」。**一旦 poll 返回 50004003(已扫待确认)
   就绝不换码**(`scanned` 标志):手机上那张确认页对应的就是这个 token,
   换了用户点「确认登录」必报「登录请求已过期」。这条和阿里「ScanSuccess 不换码」同源。

自测(设备上):

```bash
curl -s "http://127.0.0.1:9978/cloud/quark/qr"                     # 取 token
curl -s "http://127.0.0.1:9978/cloud/quark/poll?token=<token>"     # 未扫 → 50004001
curl -s "http://127.0.0.1:9978/cloud/quark/st?st=faketicket1234567890"
# → {"ok":false,...,"message":"{\"success\":false,\"code\":\"AUTH_ERROR:50051\",\"msg\":\"Invalid service ticket\"}"}
# 假票据能被夸克明确拒绝 = 兑换链路是通的,错误也如实抛出(不会伪装成空目录)
```

夸克的码同样是**只认夸克 App 内的「扫一扫」**:用相机/微信扫会跳到网页,状态永远停在 `50004001`。
面板因此复用阿里那套提示(黄框警告 + 25 秒后自动弹诊断 + 点码放大)。
