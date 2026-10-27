package tv.yingshi.app;

import android.content.Context;
import android.content.res.AssetManager;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.InetAddress;
import java.net.NetworkInterface;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URL;
import java.util.Collections;
import java.util.List;
import java.util.ArrayList;
import org.json.JSONObject;

/**
 * 局域网迷你服务器(0.0.0.0:9978):
 *  - /remote /push       手机遥控页 / 配置推送页(assets 托管)
 *  - /rc/state|cmd|poll|info   遥控通道(与 node server.js 同协议)
 *  - /cfg/push|get       手机扫码推送配置通道
 *  - /cloud/ali|quark/*  云盘接口中转(阿里OAuth扫码 / 夸克Cookie)
 * 页面(file://源)通过 http://127.0.0.1:9978 前缀访问,CORS 全开。
 */
public class MiniServer {
    private static final int PORT = 9978;
    private static final String UA_PC =
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
    private static final String ALI_OAUTH = "https://aliyundrive-oauth.messense.me";
    private static final String ALI_OPEN = "https://openapi.aliyundrive.com";

    private static Context ctx;
    private static String rcState = "{\"ended\":true}";
    private static final List<String> rcCmds = Collections.synchronizedList(new ArrayList<String>());
    private static long rcSeq = 0;
    private static String cfgPush = null;       // JSON {url,ts}
    private static long cfgTs = 0;

    public static void start(Context c) {
        if (ctx != null) return;
        ctx = c.getApplicationContext();
        new Thread(new Runnable() { public void run() {
            try {
                ServerSocket ss = new ServerSocket(PORT, 64, InetAddress.getByName("0.0.0.0"));
                while (true) {
                    final Socket sk = ss.accept();
                    new Thread(new Runnable() { public void run() { serve(sk); } }).start();
                }
            } catch (Throwable t) {
                android.util.Log.e("TVSRV", "mini server: " + t);
            }
        }}).start();
    }

    /* ---------------- HTTP 基础 ---------------- */
    /* 按字节读一行(到 \n 为止,去 \r)。必须用字节流:BufferedReader 会预读 body 进字符缓冲,
     * 导致后面按字节读 body 丢数据;且 clen 是字节数,用字符流读多字节字符(中文)会错位挂死 */
    private static String readLineBytes(java.io.InputStream in) throws Exception {
        StringBuilder b = new StringBuilder();
        int c;
        while ((c = in.read()) != -1) {
            if (c == '\n') break;
            if (c != '\r') b.append((char) c);
        }
        return b.toString();
    }

    private static void serve(Socket sk) {
        try {
            java.io.BufferedInputStream in = new java.io.BufferedInputStream(sk.getInputStream());
            String reqLine = readLineBytes(in);
            if (reqLine.isEmpty()) { sk.close(); return; }
            String[] parts = reqLine.split(" ");
            String method = parts[0];
            String pathQ = parts.length > 1 ? parts[1] : "/";
            int qi = pathQ.indexOf('?');
            String path = qi >= 0 ? pathQ.substring(0, qi) : pathQ;
            String query = qi >= 0 ? pathQ.substring(qi + 1) : "";

            int clen = 0; String range = null;
            String line;
            while (!(line = readLineBytes(in)).isEmpty()) {
                String low = line.toLowerCase();
                if (low.startsWith("content-length:")) clen = Integer.parseInt(line.substring(15).trim());
                if (low.startsWith("range:")) range = line.substring(6).trim();
            }
            /* body 按 Content-Length 读「字节」,再统一 UTF-8 解码(之前按字符读,含中文的 POST 永久阻塞) */
            String body = "";
            if (clen > 0) {
                if (clen > 8 * 1024 * 1024) clen = 8 * 1024 * 1024;
                byte[] bb = new byte[clen];
                int off = 0, n;
                while (off < clen && (n = in.read(bb, off, clen - off)) > 0) off += n;
                body = new String(bb, 0, off, "utf-8");
            }
            try { android.util.Log.i("TVSRV", method + " " + path + (query.isEmpty() ? "" : "?" + query.substring(0, Math.min(60, query.length())))); } catch (Throwable ignored) {}

            route(sk, method, path, query, body, range);
        } catch (Throwable t) {
            try { sk.close(); } catch (Exception ignored) {}
        }
    }

    private static void json(Socket sk, int code, String body) {
        reply(sk, code, "application/json; charset=utf-8", body.getBytes(), true);
    }

    private static void json(Socket sk, int code, String body, boolean noStore) {
        reply(sk, code, "application/json; charset=utf-8", body.getBytes(), noStore);
    }

    private static void reply(Socket sk, int code, String ctype, byte[] data) {
        reply(sk, code, ctype, data, false);
    }

    /* noStore:云盘/遥控等动态接口必须禁缓存,否则 WebView 会把第一次的 WaitLogin 缓存住 */
    private static void reply(Socket sk, int code, String ctype, byte[] data, boolean noStore) {
        try {
            OutputStream out = sk.getOutputStream();
            out.write(("HTTP/1.1 " + code + " OK\r\n" +
                "Content-Type: " + ctype + "\r\n" +
                "Content-Length: " + data.length + "\r\n" +
                "Access-Control-Allow-Origin: *\r\n" +
                "Access-Control-Allow-Headers: *\r\n" +
                "Access-Control-Allow-Methods: GET,POST,OPTIONS\r\n" +
                (noStore ? "Cache-Control: no-store\r\n" : "") +
                "Connection: close\r\n\r\n").getBytes());
            out.write(data);
            out.flush();
            sk.close();
        } catch (Throwable t) {
            try { sk.close(); } catch (Exception ignored) {}
        }
    }

    private static String qp(String query, String key) {
        for (String p : query.split("&")) {
            int e = p.indexOf('=');
            if (e > 0 && p.substring(0, e).equals(key)) return urlDecode(p.substring(e + 1));
        }
        return "";
    }

    private static String urlDecode(String s) {
        try { return java.net.URLDecoder.decode(s, "utf-8"); } catch (Throwable t) { return s; }
    }

    /* 路径解码:不把 '+' 当空格(URL 路径里的 '+' 是字面量) */
    private static String urlDecodePath(String s) {
        try { return java.net.URLDecoder.decode(s.replace("+", "%2B"), "utf-8"); } catch (Throwable t) { return s; }
    }

    /* POST 参数:同时吃 form-urlencoded 与 JSON 两种 body(前端用 form,外部脚本用 JSON 都能通) */
    private static String postArg(String body, String key, String dft) {
        if (body != null && body.length() > 0) {
            String v = qp(body, key);
            if (v.length() > 0) return v;
            try {
                JSONObject j = new JSONObject(body);
                if (j.has(key)) return j.optString(key, dft);
            } catch (Throwable ignored) {}
        }
        return dft;
    }

    /* ---------------- 路由 ---------------- */
    private static void route(Socket sk, String method, String path, String query, String body, String range) {
        try {
            if (method.equals("OPTIONS")) { reply(sk, 200, "text/plain", new byte[0]); return; }

            if (path.equals("/remote") || path.equals("/remote/")) { asset(sk, "www_remote.html"); return; }
            if (path.equals("/push") || path.equals("/push/")) { asset(sk, "www_push.html"); return; }

            /* ---- 遥控 ---- */
            if (path.equals("/rc/state") && method.equals("POST")) {
                if (body.length() > 0) rcState = body;
                json(sk, 200, "{\"ok\":true}"); return;
            }
            if (path.equals("/rc/state")) { json(sk, 200, rcState); return; }
            if (path.equals("/rc/cmd") && method.equals("POST")) {
                try {
                    JSONObject j = new JSONObject(body);
                    if (j.has("type")) {
                        synchronized (MiniServer.class) { rcCmds.add(++rcSeq + "\u0001" + body); if (rcCmds.size() > 60) rcCmds.remove(0); }
                    }
                } catch (Throwable ignored) {}
                json(sk, 200, "{\"ok\":true}"); return;
            }
            if (path.equals("/rc/poll")) {
                long since = 0;
                try { since = Long.parseLong(qp(query, "since")); } catch (Throwable ignored) {}
                StringBuilder b = new StringBuilder("{\"cmds\":[");
                synchronized (MiniServer.class) {
                    boolean first = true;
                    for (String c : rcCmds) {
                        int e = c.indexOf('\u0001');
                        long id = Long.parseLong(c.substring(0, e));
                        if (id > since) {
                            if (!first) b.append(',');
                            JSONObject cmd = new JSONObject(c.substring(e + 1));
                            cmd.put("id", id);
                            b.append(cmd.toString());
                            first = false;
                        }
                    }
                }
                b.append("]}");
                json(sk, 200, b.toString()); return;
            }
            if (path.equals("/rc/info")) {
                json(sk, 200, "{\"url\":\"http://" + lanIp() + ":" + PORT + "/remote\"}"); return;
            }

            /* ---- 配置推送 ---- */
            if (path.equals("/cfg/push") && method.equals("POST")) {
                try {
                    String url = new JSONObject(body).optString("url", "").trim();
                    if (url.startsWith("http://") || url.startsWith("https://")) {
                        cfgPush = body; cfgTs = System.currentTimeMillis();
                        json(sk, 200, "{\"ok\":true}");
                    } else json(sk, 200, "{\"ok\":false,\"error\":\"链接需以 http(s):// 开头\"}");
                } catch (Throwable t) { json(sk, 200, "{\"ok\":false,\"error\":\"bad json\"}"); }
                return;
            }
            if (path.equals("/cfg/get")) {
                long since = 0;
                try { since = Long.parseLong(qp(query, "ts")); } catch (Throwable ignored) {}
                if (cfgPush != null && cfgTs > since) json(sk, 200, cfgPush);
                else json(sk, 200, "{\"empty\":true}");
                return;
            }

            /* ---- 云盘中转(与 server.js 同形) ---- */
            if (path.equals("/cloud/ali/qr")) {
                passthrough(sk, "POST", ALI_OAUTH + "/oauth/authorize/qrcode",
                    "{\"scopes\":[\"user:base\",\"file:all:read\",\"file:all:write\"]}", null, null); return;
            }
            if (path.equals("/cloud/ali/poll")) {
                passthrough(sk, "GET", ALI_OPEN + "/oauth/qrcode/" + qp(query, "sid") + "/status", null, null, null); return;
            }
            if (path.equals("/cloud/ali/token")) {
                passthrough(sk, "POST", ALI_OAUTH + "/oauth/access_token",
                    "{\"grant_type\":\"authorization_code\",\"code\":\"" + new JSONObject(body).optString("code") + "\"}", null, null); return;
            }
            if (path.equals("/cloud/ali/refresh")) {
                passthrough(sk, "POST", ALI_OAUTH + "/oauth/access_token",
                    "{\"grant_type\":\"refresh_token\",\"refresh_token\":\"" + new JSONObject(body).optString("refresh_token") + "\"}", null, null); return;
            }
            if (path.equals("/cloud/ali/list")) {
                passthrough(sk, "POST", ALI_OPEN + "/adrive/v1.0/openFile/list",
                    "{\"drive_id\":\"" + qp(query, "d") + "\",\"parent_file_id\":\"" + qp(query, "p") + "\",\"limit\":200,\"order_by\":\"type\",\"order_direction\":\"ASC\"}",
                    "Bearer " + qp(query, "t"), null); return;
            }
            if (path.equals("/cloud/ali/link")) {
                passthrough(sk, "POST", ALI_OPEN + "/adrive/v1.0/openFile/get",
                    "{\"drive_id\":\"" + qp(query, "d") + "\",\"file_id\":\"" + qp(query, "fid") + "\",\"expire_sec\":14400}",
                    "Bearer " + qp(query, "t"), null); return;
            }
            if (path.equals("/cloud/quark/list")) {
                passthrough(sk, "GET",
                    "https://drive-pc.quark.cn/1/clouddrive/file/sort?pr=ucpro&fr=pc&pdir_fid=" + qp(query, "p") +
                    "&_page=1&_size=200&_fetch_total=1&_fetch_sub_dirs=0&_sort=file_type:asc,file_name:asc",
                    null, null, qp(query, "c")); return;
            }
            if (path.equals("/cloud/quark/link")) {
                passthrough(sk, "POST",
                    "https://drive-pc.quark.cn/1/clouddrive/file/download?pr=ucpro&fr=pc&fid=" + qp(query, "fid"),
                    "{}", null, qp(query, "c")); return;
            }
            /* 夸克扫码:取二维码 token → 轮询 service_ticket → 换登录态(__puus 只在 Set-Cookie 里) */
            if (path.equals("/cloud/quark/qr")) {
                passthrough(sk, "GET",
                    "https://uop.quark.cn/cas/ajax/getTokenForQrcodeLogin?client_id=532&v=1.2",
                    null, null, null); return;
            }
            if (path.equals("/cloud/quark/poll")) {
                passthrough(sk, "GET",
                    "https://uop.quark.cn/cas/ajax/getServiceTicketByQrcodeToken?client_id=532&v=1.2&token=" +
                    qp(query, "token"), null, null, null); return;
            }
            if (path.equals("/cloud/quark/st")) {
                quarkTicket(sk, qp(query, "st")); return;
            }
            if (path.equals("/cloud/dl")) {
                String target = qp(query, "u");
                boolean quark = "1".equals(qp(query, "h"));
                streamOut(sk, target, range, quark); return;
            }

            /* ---- 通用录音:网页取回刚录的 WAV 再发云端 ASR(仅本机,音频不出局域网) ---- */
            if (path.equals("/voice/wav") || path.equals("/voice/state")) {
                if (!sk.getInetAddress().isLoopbackAddress()) {
                    json(sk, 403, "{\"error\":\"forbidden\"}"); return;
                }
                if (path.equals("/voice/state")) {
                    json(sk, 200, VoiceRec.state().toString(), true); return;
                }
                java.io.File wf = VoiceRec.wavFile(ctx);
                if (!wf.exists() || wf.length() == 0) {
                    json(sk, 404, "{\"error\":\"no audio\"}", true); return;
                }
                byte[] wb;
                try {
                    java.io.FileInputStream in = new java.io.FileInputStream(wf);
                    wb = new byte[(int) wf.length()];
                    int off = 0, r;
                    while (off < wb.length && (r = in.read(wb, off, wb.length - off)) > 0) off += r;
                    in.close();
                } catch (Throwable t) {
                    json(sk, 500, "{\"error\":\"read fail\"}", true); return;
                }
                reply(sk, 200, "audio/wav", wb, true); return;
            }

            /* ---- 系统能力:WiFi / 蓝牙(仅本机可调,避免局域网设备动本机网络) ---- */
            if (path.startsWith("/sys/")) {
                if (!sk.getInetAddress().isLoopbackAddress()) {
                    json(sk, 403, "{\"error\":\"forbidden\"}"); return;
                }
                if (path.equals("/sys/info")) { json(sk, 200, SysCtl.info(ctx).toString(), true); return; }
                if (path.equals("/sys/wifi/state")) { json(sk, 200, SysCtl.wifiState(ctx).toString(), true); return; }
                if (path.equals("/sys/wifi/scan")) { json(sk, 200, SysCtl.wifiScan(ctx).toString(), true); return; }
                if (path.equals("/sys/wifi/connect")) {
                    String s = postArg(body, "ssid", qp(query, "ssid"));
                    String p = postArg(body, "pwd", qp(query, "pwd"));
                    json(sk, 200, SysCtl.wifiConnect(ctx, s, p).toString(), true); return;
                }
                if (path.equals("/sys/wifi/open")) { SysCtl.openWifiSettings(ctx); json(sk, 200, "{\"ok\":true}"); return; }
                if (path.equals("/sys/bt/state")) { json(sk, 200, SysCtl.btState(ctx).toString(), true); return; }
                if (path.equals("/sys/bt/scan")) { json(sk, 200, SysCtl.btScan(ctx).toString(), true); return; }
                if (path.equals("/sys/bt/pair")) {
                    json(sk, 200, SysCtl.btPair(ctx, postArg(body, "mac", qp(query, "mac"))).toString(), true); return;
                }
                if (path.equals("/sys/bt/connect")) {
                    json(sk, 200, SysCtl.btConnect(ctx, postArg(body, "mac", qp(query, "mac"))).toString(), true); return;
                }
                if (path.equals("/sys/bt/enable")) { SysCtl.requestBtEnable(ctx); json(sk, 200, "{\"ok\":true,\"msg\":\"已弹出蓝牙开启确认\"}"); return; }
                if (path.equals("/sys/bt/open")) { SysCtl.openBtSettings(ctx); json(sk, 200, "{\"ok\":true}"); return; }
                if (path.equals("/sys/perm")) {
                    boolean w = "1".equals(qp(query, "w")) || "true".equals(qp(query, "w"));
                    boolean b = "1".equals(qp(query, "b")) || "true".equals(qp(query, "b"));
                    boolean ok = SysCtl.ensurePerms(ctx, w, b);
                    json(sk, 200, "{\"ok\":" + ok + ",\"wifi\":" + (SysCtl.missingWiFi(ctx).size() == 0) +
                            ",\"bt\":" + (SysCtl.missingBt(ctx).size() == 0) + "}", true); return;
                }
                json(sk, 404, "{\"error\":\"unknown sys api\"}"); return;
            }

            /* ---- U盘/本地存储(即插即播:卷检测 + 目录浏览 + Range 流式播放) ----
               仅允许本机(127.0.0.1)访问,避免局域网设备借该通道读取本机文件 */
            if (path.startsWith("/usb/")) {
                if (!sk.getInetAddress().isLoopbackAddress()) {
                    json(sk, 403, "{\"error\":\"forbidden\"}"); return;
                }
                if (path.equals("/usb/vols")) { json(sk, 200, usbVolsJson(), true); return; }
                if (path.equals("/usb/list")) { usbList(sk, qp(query, "p")); return; }
                if (path.equals("/usb/get")) { usbGet(sk, qp(query, "p"), range); return; }
            }

                        /* ---- 在线字幕(SubHD) ---- */
            if (path.equals("/sub/search")) {
                try {
                    String kw = qp(query, "kw");
                    HttpURLConnection c = (HttpURLConnection) new URL("https://subhd.tv/search/" + java.net.URLEncoder.encode(kw, "utf-8")).openConnection();
                    c.setRequestProperty("User-Agent", UA_PC);
                    String html = readAll(c.getInputStream());
                    StringBuilder b = new StringBuilder("{\"list\":[");
                    java.util.regex.Matcher m = java.util.regex.Pattern
                        .compile("<a[^>]+href=['\"]\\/a\\/([A-Za-z0-9]+)['\"][^>]*>([\\s\\S]{0,200}?)<\\/a>").matcher(html);
                    java.util.Set<String> seen = new java.util.HashSet<>();
                    int n = 0;
                    while (m.find() && n < 40) {
                        String id = m.group(1);
                        String name = m.group(2).replaceAll("<[^>]+>", "").trim();
                        if (seen.contains(id) || name.length() < 3) continue;
                        seen.add(id);
                        String around = html.substring(Math.max(0, m.start() - 100), Math.min(html.length(), m.start() + 1600)).replaceAll("<[^>]+>", " ");
                        java.util.Set<String> ls = new java.util.LinkedHashSet<>();
                        java.util.regex.Matcher lm = java.util.regex.Pattern.compile("(简体|繁体|双语|英文|中英|特效)").matcher(around);
                        while (lm.find()) ls.add(lm.group(1));
                        String fmt = "";
                        java.util.regex.Matcher fm = java.util.regex.Pattern.compile("(SRT|ASS|SSA|VTT)").matcher(around);
                        if (fm.find()) fmt = fm.group(1);
                        if (n > 0) b.append(',');
                        b.append("{\"id\":\"").append(id).append("\",\"name\":\"")
                         .append(esc(name.substring(0, Math.min(60, name.length()))))
                         .append("\",\"lang\":\"").append(String.join("/", ls)).append("\",\"fmt\":\"").append(fmt).append("\"}");
                        n++;
                    }
                    b.append("]}");
                    json(sk, 200, b.toString());
                } catch (Throwable t) { json(sk, 502, "{\"error\":\"" + t.getMessage() + "\"}"); }
                return;
            }
            if (path.equals("/sub/down")) {
                try {
                    String id = qp(query, "id");
                    StringBuilder jar = new StringBuilder();   // 会话 cookie:prepare 种 down_ 票据
                    String j1 = httpTextJar("POST", "https://subhd.tv/api/sub/prepare-download",
                        "{\"sid\":\"" + id + "\"}", null, jar);
                    if (!j1.contains("\"success\":true")) { json(sk, 502, "{\"error\":\"prepare失败\"}"); return; }
                    httpTextJar("GET", "https://subhd.tv/down/" + id, null, null, jar);
                    String j2 = httpTextJar("POST", "https://subhd.tv/api/sub/down",
                        "{\"sid\":\"" + id + "\"}", null, jar);
                    java.util.regex.Matcher um = java.util.regex.Pattern.compile("\"url\":\"(https?:[^\"]+)\"").matcher(j2);
                    if (!j2.contains("\"success\":true") || !um.find()) { json(sk, 502, "{\"error\":\"下载失败\"}"); return; }
                    byte[] data = unzipSub(httpBytes(um.group(1)));
                    reply(sk, 200, "application/octet-stream", data);
                } catch (Throwable t) { json(sk, 502, "{\"error\":\"" + t.getMessage() + "\"}"); }
                return;
            }
            /* ---- 弹幕接口 ---- */
            if (path.equals("/dm/fetch")) {
                try {
                    org.json.JSONObject q0 = new org.json.JSONObject(body);
                    String fileName = q0.optString("fileName", "");
                    String name = q0.optString("name", "").trim();
                    String ep = q0.optString("ep", "").trim();
                    double dur = q0.optDouble("duration", 0);
                    if (fileName.isEmpty() && name.isEmpty()) { json(sk, 200, "{\"error\":\"缺少片名\"}"); return; }
                    String tpl = q0.optString("tpl", "");
                    String xml = null, from = "", dErr = "";
                    lastDmMatch = "";
                    if (tpl.startsWith("http")) {
                        String u = tpl.replace("{fileName}", java.net.URLEncoder.encode(fileName.isEmpty() ? name : fileName, "utf-8"))
                                      .replace("{filename}", java.net.URLEncoder.encode(fileName.isEmpty() ? name : fileName, "utf-8"));
                        String text = httpText("GET", u, null, null);
                        xml = text;
                        try {
                            org.json.JSONObject j = new org.json.JSONObject(text);
                            if (j.has("comments")) {
                                StringBuilder b = new StringBuilder("<?xml version=\"1.0\"?><i>");
                                org.json.JSONArray cs = j.getJSONArray("comments");
                                for (int i = 0; i < cs.length(); i++) {
                                    org.json.JSONObject cm = cs.getJSONObject(i);
                                    double sh = cm.optDouble("shift", cm.optDouble("time", 0));
                                    b.append("<d p=\"").append(sh).append(",1,25,16777215,").append((long) (sh * 1000)).append(",0,0,0\">")
                                     .append(esc(cm.optString("text", ""))).append("</d>");
                                }
                                xml = b.append("</i>").toString();
                            }
                        } catch (Exception ignored) {}
                        from = "tpl";
                    } else {
                        String appId = q0.optString("appId", ""), appSecret = q0.optString("appSecret", "");
                        if (!appId.isEmpty() && !appSecret.isEmpty()) {
                            try {
                                String ts = String.valueOf(System.currentTimeMillis() / 1000);
                                String mp = "/api/v2/match";
                                String fname = fileName.isEmpty() ? (name + " " + ep).trim() : fileName;
                                org.json.JSONObject mm = new org.json.JSONObject(httpText("POST", "https://api.dandanplay.net" + mp,
                                    "{\"fileName\":\"" + esc(fname) + "\",\"fileHash\":\"\",\"fileSize\":0,\"videoDuration\":0,\"matchMode\":1}",
                                    dandanHeaders(appId, appSecret, ts, mp)));
                                org.json.JSONArray ms = mm.optJSONArray("matches");
                                if (mm.optBoolean("isMatched") && ms != null && ms.length() > 0) {
                                    org.json.JSONObject m0 = ms.optJSONObject(0);
                                    String epId = m0 == null ? "" : m0.optString("episodeId", "");
                                    String cp = "/api/v2/comment/" + epId + "?withRelated=true&chConvert=1";
                                    org.json.JSONObject cc = new org.json.JSONObject(httpText("GET", "https://api.dandanplay.net" + cp, null,
                                        dandanHeaders(appId, appSecret, ts, cp)));
                                org.json.JSONArray cs = cc.optJSONArray("comments");
                                if (cs != null) {
                                    StringBuilder b = new StringBuilder("<?xml version=\"1.0\"?><i>");
                                    for (int i = 0; i < cs.length(); i++) {
                                        org.json.JSONObject cm = cs.optJSONObject(i);
                                        if (cm == null) continue;
                                        /* 弹弹play JSON: p="秒,模式,颜色,用户hash", m=弹幕文本。
                                           p 原样放进 XML 的 p 属性(时间/模式/颜色都保留),文本必须用 m ——
                                           以前这里把 p(逗号数字串)当文本弹出来,全是乱码数字。 */
                                        String pp = cm.optString("p", "").trim();
                                        String mt = cm.optString("m", "").trim();
                                        if (!pp.isEmpty() && !mt.isEmpty()) {
                                            b.append("<d p=\"").append(esc(pp)).append("\">").append(esc(mt)).append("</d>");
                                        }
                                    }
                                    xml = b.append("</i>").toString();
                                    from = "dandanplay";
                                    lastDmMatch = m0 == null ? "" : m0.optString("episodeTitle", "");
                                }
                                }
                            } catch (Throwable t) { dErr = String.valueOf(t.getMessage()); }
                        }
                        /* 公益弹幕(弹弹play 兼容免凭证代理,默认启用):
                           选源顺序 = 自定义模板 → 弹弹play官方(凭证) → 公益 → B站内置。
                           gy: 空=内置默认地址; http开头=自定义代理; off=禁用走B站。 */
                        if (xml == null) {
                            String gy = q0.optString("gy", "").trim();
                            if (!gy.equalsIgnoreCase("off")) {
                                try {
                                    xml = gongyiDm(name.isEmpty() ? fileName : name, ep,
                                        gy.startsWith("http") ? gy : "");
                                    if (xml != null) from = "gongyi";
                                } catch (Throwable t) { dErr = "公益:" + t.getMessage(); }
                            }
                        }
                        if (xml == null) {
                            try {
                                xml = biliDm(name.isEmpty() ? fileName : name, ep, dur);
                                if (xml != null) from = "bilibili";
                            } catch (Throwable t) {
                                json(sk, 200, "{\"error\":\"弹幕获取失败:" + esc(String.valueOf(t.getMessage())) + "\"}");
                                return;
                            }
                        }
                        if (xml == null) {
                            json(sk, 200, "{\"error\":\"没找到匹配的弹幕" + esc(dErr.isEmpty() ? "(B站没有这一集的上传)" : "(" + dErr + ")") + "\"}");
                            return;
                        }
                    }
                    String cut = xml.substring(0, Math.min(xml.length(), 3000000));
                    int count = 0;
                    for (int i = cut.indexOf("<d p="); i >= 0; i = cut.indexOf("<d p=", i + 1)) count++;
                    json(sk, 200, "{\"xml\":\"" + esc(cut) + "\",\"from\":\"" + from + "\",\"matched\":\"" + esc(lastDmMatch) + "\",\"count\":" + count + "}");
                } catch (Throwable t) { json(sk, 502, "{\"error\":\"" + esc(String.valueOf(t.getMessage())) + "\"}"); }
                return;
            }

            /* ---- 通用文本代理(App 内 file:// 页面无法用相对 /proxy) ----
               用法:/proxy/<完整URL>[?ref=<referer>][&h=Header: value]
               目标自身的 query 会被浏览器拆到代理 query 上,这里再拼回目标(去掉 ref/h/a 代理专属参数) */
            if (path.equals("/proxy") || path.startsWith("/proxy/")) {
                proxyText(sk, path, query);
                return;
            }

            /* ---- 直链提取:从网页分享页里解析出真正的 m3u8/mp4 地址 ----
               用法:/sniff2/<完整URL>[?ref=<referer>]
               很多采集源的 play_url 是 HTML 分享页(/share/xxx 或 /play/xxx),
               直接塞进 video 元素只会卡在 0:00。这里在服务端抓页面、抽取直链。 */
            if (path.equals("/sniff2") || path.startsWith("/sniff2/")) {
                sniffResolve(sk, path, query);
                return;
            }

            /* ---- 静态资源回退:路径拍平到 assets-flat 命名(www_ + / 换 _) ---- */
            if (method.equals("GET") || method.equals("HEAD")) {
                String flat = path.equals("/") || path.isEmpty()
                        ? "www_index.html"
                        : "www_" + path.substring(1).replace('/', '_');
                if (!flat.contains("..")) { staticAsset(sk, flat, range); return; }
            }

            reply(sk, 404, "application/json", "{\"error\":\"unknown\"}".getBytes());
        } catch (Throwable t) {
            json(sk, 502, "{\"error\":\"" + t.getMessage() + "\"}");
        }
    }

    /* 通用文本代理:/proxy/<完整URL>[?ref=<referer>][&h=Header: value]
       目标自身 query 由浏览器拆到代理 query 上,这里拼回目标(ref/h/a 为代理专属参数,不拼回) */
    /* ---- 直链提取:/sniff2/<完整URL>[?ref=<referer>]
       采集源给的 play_url 常是 HTML 分享页(带广告),视频地址藏在页面 JS 里
       (常见:var main = "/2026.../index.m3u8?sign=xxx")。
       流程:抓页面(跟随重定向) → 正则抽候选 → 逐个探测是否为真 m3u8/mp4 → 返回可用直链。 */
    private static void sniffResolve(Socket sk, String path, String query) {
        String target = path.startsWith("/sniff2/") ? urlDecodePath(path.substring("/sniff2/".length())) : "";
        if (target.isEmpty()) target = qp(query, "u");
        /* base64url 参数:App 侧用 ?b=<base64url> 传目标 URL(避免 %2F 被 Chromium 丢弃) */
        if (target.isEmpty()) {
            String b = qp(query, "b");
            if (!b.isEmpty()) {
                try {
                    byte[] raw = android.util.Base64.decode(b, android.util.Base64.URL_SAFE | android.util.Base64.NO_PADDING | android.util.Base64.NO_WRAP);
                    target = new String(raw, "UTF-8");
                } catch (Throwable t) { target = ""; }
            }
        }
        String ref = qp(query, "ref");
        try { android.util.Log.i("TVSRV", "sniff2 target=" + target); } catch (Throwable ignored) {}
        if (!target.startsWith("http://") && !target.startsWith("https://")) {
            json(sk, 400, "{\"ok\":false,\"error\":\"bad url\"}");
            return;
        }
        try {
            String finalUrl = target;
            String ctype = "";
            String body = "";
            for (int hop = 0; hop < 5; hop++) {
                HttpURLConnection c = (HttpURLConnection) new URL(finalUrl).openConnection();
                c.setConnectTimeout(12000);
                c.setReadTimeout(20000);
                c.setInstanceFollowRedirects(false);
                c.setRequestProperty("User-Agent", UA_PC);
                c.setRequestProperty("Accept", "*/*");
                if (!ref.isEmpty()) c.setRequestProperty("Referer", ref);
                int code = c.getResponseCode();
                if (code >= 300 && code < 400) {
                    String loc = c.getHeaderField("Location");
                    if (loc == null || loc.isEmpty()) break;
                    finalUrl = new URL(new URL(finalUrl), loc).toString();
                    try { c.getInputStream().close(); } catch (Throwable ignored) {}
                    continue;
                }
                ctype = (c.getContentType() == null) ? "" : c.getContentType().toLowerCase();
                byte[] data = readAllBytes(c.getInputStream());
                body = decodeText(data);
                break;
            }
            /* 目标本身就是媒体文件 → 已是直链;顺带探测真实高度,前端据此排档/显示徽标 */
            if (ctype.contains("mpegurl") || ctype.contains("video/mp4") || ctype.contains("application/x-mpegurl")) {
                int dh = finalUrl.toLowerCase().contains(".m3u8") ? probeResolution(finalUrl, ref) : 0;
                json(sk, 200, "{\"ok\":true,\"direct\":true,\"urls\":[\"" + jsonEsc(finalUrl) + "\"],\"quality\":["
                        + dh + "],\"page\":\"" + jsonEsc(finalUrl) + "\"}");
                return;
            }
            List<String> cands = new ArrayList<String>();
            collectMediaCandidates(body, finalUrl, cands);
            List<String> ok = new ArrayList<String>();
            for (int i = 0; i < cands.size() && ok.size() < 5; i++) {
                if (probeMedia(cands.get(i), ref)) ok.add(cands.get(i));
            }
            if (ok.isEmpty()) {
                json(sk, 200, "{\"ok\":false,\"error\":\"no media url found\"}");
                return;
            }
            /* 分辨率感知排序:1080P 优先,其次更高清,最后未知 */
            int n = ok.size();
            int[] heights = new int[n];
            for (int i = 0; i < n; i++) {
                String cu = ok.get(i);
                heights[i] = cu.toLowerCase().matches("(?i).*\\.m3u8(\\?.*)?$") ? probeResolution(cu, ref) : 0;
            }
            for (int i = 0; i < n - 1; i++) {
                for (int j = i + 1; j < n; j++) {
                    if (heights[j] > heights[i]) {
                        int th = heights[i]; heights[i] = heights[j]; heights[j] = th;
                        String ts = ok.get(i); ok.set(i, ok.get(j)); ok.set(j, ts);
                    }
                }
            }
            StringBuilder sb = new StringBuilder();
            sb.append("{\"ok\":true,\"urls\":[");
            for (int i = 0; i < ok.size(); i++) {
                if (i > 0) sb.append(",");
                sb.append("\"").append(jsonEsc(ok.get(i))).append("\"");
            }
            sb.append("],\"quality\":[");
            for (int i = 0; i < heights.length; i++) {
                if (i > 0) sb.append(",");
                sb.append(heights[i]);
            }
            sb.append("],\"page\":\"").append(jsonEsc(finalUrl)).append("\"}");
            json(sk, 200, sb.toString());
        } catch (Throwable t) {
            json(sk, 200, "{\"ok\":false,\"error\":\"" + jsonEsc(String.valueOf(t.getMessage())) + "\"}");
        }
    }

    /* 从 HTML/JS 文本里抽取媒体地址候选(绝对地址与相对路径都收) */
    private static void collectMediaCandidates(String html, String baseUrl, List<String> out) {
        if (html == null || html.isEmpty()) return;
        String h = html.replace("\\/", "/").replace("&amp;", "&");
        /* ① 变量赋值形式:var main = "/xxx/index.m3u8?sign=.." / "file":"..mp4" */
        java.util.regex.Matcher m1 = java.util.regex.Pattern.compile(
            "(?i)(?:main|video_url|videourl|m3u8_url|m3u8url|url|file|src|play_url|playurl|src_url|hls)\\s*[:=]\\s*[\"']([^\"'<>\\s]{6,400})[\"']"
        ).matcher(h);
        while (m1.find()) addCand(m1.group(1), baseUrl, out);
        /* ② 任意 .m3u8 字面量 */
        java.util.regex.Matcher m2 = java.util.regex.Pattern.compile(
            "[\"']([^\"'<>\\s]{0,400}\\.m3u8[^\"'<>\\s]{0,200})[\"']"
        ).matcher(h);
        while (m2.find()) addCand(m2.group(1), baseUrl, out);
        /* ③ 任意 .mp4 字面量 */
        java.util.regex.Matcher m3 = java.util.regex.Pattern.compile(
            "[\"']([^\"'<>\\s]{0,400}\\.mp4[^\"'<>\\s]{0,120})[\"']"
        ).matcher(h);
        while (m3.find()) addCand(m3.group(1), baseUrl, out);
    }

    private static void addCand(String raw, String baseUrl, List<String> out) {
        if (raw == null) return;
        String s = raw.trim();
        if (s.isEmpty()) return;
        if (s.startsWith("//")) s = "https:" + s;
        else if (!s.startsWith("http://") && !s.startsWith("https://")) {
            try { s = new URL(new URL(baseUrl), s).toString(); } catch (Throwable t) { return; }
        }
        if (!s.matches("(?i).*\\.m3u8(\\?.*)?$") && !s.matches("(?i).*\\.mp4(\\?.*)?$")) return;
        if (out.contains(s)) return;
        out.add(s);
    }

    /* 探测候选是否为真媒体地址(认 content-type 或 #EXTM3U 头) */
    private static boolean probeMedia(String u, String ref) {
        try {
            HttpURLConnection c = (HttpURLConnection) new URL(u).openConnection();
            c.setConnectTimeout(9000);
            c.setReadTimeout(12000);
            c.setInstanceFollowRedirects(true);
            c.setRequestProperty("User-Agent", UA_PC);
            c.setRequestProperty("Accept", "*/*");
            c.setRequestProperty("Range", "bytes=0-2047");
            if (!ref.isEmpty()) c.setRequestProperty("Referer", ref);
            int code = c.getResponseCode();
            if (code >= 400) return false;
            String ct = (c.getContentType() == null) ? "" : c.getContentType().toLowerCase();
            if (ct.contains("mpegurl") || ct.contains("video/mp4")) {
                try { c.getInputStream().close(); } catch (Throwable ignored) {}
                return true;
            }
            InputStream is = c.getInputStream();
            byte[] buf = new byte[16];
            int n = is.read(buf);
            try { is.close(); } catch (Throwable ignored) {}
            if (n > 0) {
                String head = new String(buf, 0, n, "UTF-8");
                if (head.startsWith("#EXTM3U")) return true;
            }
            return false;
        } catch (Throwable t) {
            return false;
        }
    }

    /* 读取 m3u8 头,返回最高分辨率高度(px);读不到返回 0
       注意:很多源写 RESOLUTION=1080x608(宽 1080 高 608),这是伪 1080,
       真实像素高度只有 608(约 480p)。所以只用高度判档位,宽度会骗人。 */
    private static int probeResolution(String u, String ref) {
        try {
            HttpURLConnection c = (HttpURLConnection) new URL(u).openConnection();
            c.setConnectTimeout(8000);
            c.setReadTimeout(10000);
            c.setInstanceFollowRedirects(true);
            c.setRequestProperty("User-Agent", UA_PC);
            c.setRequestProperty("Accept", "*/*");
            if (!ref.isEmpty()) c.setRequestProperty("Referer", ref);
            int code = c.getResponseCode();
            if (code >= 400) return 0;
            InputStream is = c.getInputStream();
            byte[] buf = new byte[8192];
            int n = is.read(buf);
            try { is.close(); } catch (Throwable ignored) {}
            if (n <= 0) return 0;
            String head = new String(buf, 0, n, "UTF-8");
            java.util.regex.Matcher m = java.util.regex.Pattern
                    .compile("RESOLUTION=\\d+x(\\d+)", java.util.regex.Pattern.CASE_INSENSITIVE).matcher(head);
            int best = 0;
            while (m.find()) {
                int h = 0;
                try { h = Integer.parseInt(m.group(1)); } catch (Throwable ignored) {}
                if (h > best) best = h;
            }
            return best;
        } catch (Throwable t) {
            return 0;
        }
    }

    /* 按 UTF-8 严格解码,失败回落 GBK(部分老站是 GBK) */
    private static String decodeText(byte[] data) {
        if (data == null) return "";
        try {
            java.nio.charset.CharsetDecoder dec = java.nio.charset.Charset.forName("UTF-8").newDecoder();
            dec.onMalformedInput(java.nio.charset.CodingErrorAction.REPORT);
            dec.onUnmappableCharacter(java.nio.charset.CodingErrorAction.REPORT);
            return dec.decode(java.nio.ByteBuffer.wrap(data)).toString();
        } catch (Throwable t) {
            try { return new String(data, "GBK"); } catch (Throwable t2) { return new String(data); }
        }
    }

    private static String jsonEsc(String s) {
        if (s == null) return "";
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if (c == '"' || c == '\\') sb.append('\\').append(c);
            else if (c == '\n' || c == '\r' || c == '\t') sb.append(' ');
            else if (c < 0x20) sb.append(' ');
            else sb.append(c);
        }
        return sb.toString();
    }

    private static void proxyText(Socket sk, String path, String query) {
        String target = path.startsWith("/proxy/") ? urlDecodePath(path.substring("/proxy/".length())) : "";
        if (target.isEmpty()) target = qp(query, "u");
        if (target.isEmpty()) {
            reply(sk, 400, "text/plain; charset=utf-8", "proxy: missing url".getBytes());
            return;
        }
        StringBuilder rest = new StringBuilder();
        String ref = "";
        java.util.Map<String, String> extraH = null;   // 通用自定义头(User-Agent/Authorization 等)
        if (query != null) {
            for (String p : query.split("&")) {
                if (p.isEmpty()) continue;
                int e = p.indexOf('=');
                String k = e > 0 ? p.substring(0, e) : p;
                String v = e > 0 ? p.substring(e + 1) : "";
                if (k.equals("ref")) { ref = urlDecode(v); continue; }
                if (k.equals("h")) {                       // 自定义头:'Name: value'
                    String hv = urlDecode(v);
                    int ci = hv.indexOf(':');
                    if (ci > 0) {
                        String hn = hv.substring(0, ci).trim();
                        String hval = hv.substring(ci + 1).trim();
                        if (hn.equalsIgnoreCase("referer")) ref = hval;
                        else {
                            if (extraH == null) extraH = new java.util.HashMap<String, String>();
                            extraH.put(hn, hval);
                        }
                    }
                    continue;
                }
                if (k.equals("a")) continue;               // 认证参数暂不支持
                if (rest.length() > 0) rest.append('&');
                rest.append(p);
            }
        }
        if (rest.length() > 0) target += (target.indexOf('?') > -1 ? '&' : '?') + rest.toString();
        if (!target.startsWith("http://") && !target.startsWith("https://")) {
            reply(sk, 400, "text/plain; charset=utf-8", "proxy: bad target".getBytes());
            return;
        }
        try {
            HttpURLConnection c = (HttpURLConnection) new URL(target).openConnection();
            c.setConnectTimeout(12000);
            c.setReadTimeout(25000);
            c.setRequestProperty("User-Agent", UA_PC);
            c.setRequestProperty("Accept", "*/*");
            if (!ref.isEmpty()) c.setRequestProperty("Referer", ref);
            if (extraH != null) for (java.util.Map.Entry<String, String> en : extraH.entrySet()) c.setRequestProperty(en.getKey(), en.getValue());
            int code = c.getResponseCode();
            InputStream is = code >= 400 ? c.getErrorStream() : c.getInputStream();
            byte[] data = (is != null) ? readAllBytes(is) : new byte[0];
            reply(sk, code < 400 ? 200 : 502, "text/plain; charset=utf-8", data);
        } catch (Throwable t) {
            reply(sk, 502, "text/plain; charset=utf-8", ("proxy error: " + t.getMessage()).getBytes());
        }
    }

    private static void staticAsset(Socket sk, String name, String range) {
        try {
            InputStream is = ctx.getAssets().open(name);
            String mime = "application/octet-stream";
            int dot = name.lastIndexOf('.');
            String ext = dot >= 0 ? name.substring(dot + 1).toLowerCase() : "";
            if (ext.equals("html")) mime = "text/html; charset=utf-8";
            else if (ext.equals("js")) mime = "application/javascript; charset=utf-8";
            else if (ext.equals("css")) mime = "text/css; charset=utf-8";
            else if (ext.equals("json")) mime = "application/json; charset=utf-8";
            else if (ext.equals("svg")) mime = "image/svg+xml";
            else if (ext.equals("png")) mime = "image/png";
            else if (ext.equals("jpg") || ext.equals("jpeg")) mime = "image/jpeg";
            else if (ext.equals("mp4")) mime = "video/mp4";
            else if (ext.equals("m3u8")) mime = "application/vnd.apple.mpegurl";
            else if (ext.equals("ts") || ext.equals("m2ts")) mime = "video/mp2t";
            else if (ext.equals("xml")) mime = "text/xml; charset=utf-8";
            else if (ext.equals("srt") || ext.equals("vtt")) mime = "text/plain; charset=utf-8";
            java.io.ByteArrayOutputStream b = new java.io.ByteArrayOutputStream();
            byte[] buf = new byte[8192]; int n;
            while ((n = is.read(buf)) != -1) b.write(buf, 0, n);
            is.close();
            reply(sk, 200, mime, b.toByteArray());
        } catch (Throwable t) {
            reply(sk, 404, "text/plain", "not found".getBytes());
        }
    }

    private static void asset(Socket sk, String name) {
        try {
            InputStream is = ctx.getAssets().open(name);
            java.io.ByteArrayOutputStream b = new java.io.ByteArrayOutputStream();
            byte[] buf = new byte[8192]; int n;
            while ((n = is.read(buf)) != -1) b.write(buf, 0, n);
            is.close();
            reply(sk, 200, "text/html; charset=utf-8", b.toByteArray());
        } catch (Throwable t) {
            reply(sk, 404, "text/plain", "not found".getBytes());
        }
    }

    /* 云盘 API 文本中转 */
    private static void passthrough(Socket sk, String method, String urlStr, String body, String bearer, String cookie) {
        try {
            HttpURLConnection c = (HttpURLConnection) new URL(urlStr).openConnection();
            c.setConnectTimeout(15000);
            c.setReadTimeout(30000);
            c.setRequestMethod(method);
            c.setRequestProperty("User-Agent", UA_PC);
            if (bearer != null) c.setRequestProperty("Authorization", bearer);
            if (cookie != null && !cookie.isEmpty()) {
                /* 只有夸克需要网页 Referer;阿里接口带上反而可能被拒 */
                c.setRequestProperty("Referer", "https://pan.quark.cn/");
                c.setRequestProperty("Cookie", cookie);
            }
            boolean post = body != null;
            c.setDoOutput(post);
            if (post) {
                c.setRequestProperty("Content-Type", "application/json");
                c.getOutputStream().write(body.getBytes("utf-8"));
            }
            int code = c.getResponseCode();
            InputStream is = code >= 400 ? c.getErrorStream() : c.getInputStream();
            java.io.ByteArrayOutputStream b = new java.io.ByteArrayOutputStream();
            byte[] buf = new byte[8192]; int n;
            if (is != null) { while ((n = is.read(buf)) != -1) b.write(buf, 0, n); is.close(); }
            reply(sk, code < 400 ? 200 : 502, "application/json; charset=utf-8", b.toByteArray(), true);
        } catch (Throwable t) {
            json(sk, 502, "{\"error\":\"" + t.getMessage() + "\"}");
        }
    }

    /* 夸克:用 service_ticket 换登录态。
     * __puus 只出现在响应的 Set-Cookie 里, 网页 fetch 拿不到(就算 CORS 通了也读不到 Set-Cookie),
     * 所以必须原生走一次; 并且把沿途所有 cookie 拼起来存 —— 只存 __puus 会缺 ctoken/__pus。 */
    private static void quarkTicket(Socket sk, String st) {
        if (st == null || st.length() < 8) {
            json(sk, 200, "{\"ok\":false,\"message\":\"service_ticket 为空\"}"); return;
        }
        java.util.LinkedHashMap<String, String> jar = new java.util.LinkedHashMap<String, String>();
        String url = "https://pan.quark.cn/account/info?st=" + st + "&lw=scan";
        String bodyText = "";
        int httpCode = 0;
        try {
            for (int hop = 0; hop < 4; hop++) {
                HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
                c.setInstanceFollowRedirects(false);   // 自己跟,否则中间跳转的 Set-Cookie 全丢
                c.setConnectTimeout(15000);
                c.setReadTimeout(20000);
                c.setRequestProperty("User-Agent", UA_PC);
                c.setRequestProperty("Referer", "https://pan.quark.cn/");
                if (jar.size() > 0) c.setRequestProperty("Cookie", joinCookies(jar));
                for (java.util.Map.Entry<String, java.util.List<String>> en : c.getHeaderFields().entrySet()) {
                    if (en.getKey() == null || !"set-cookie".equalsIgnoreCase(en.getKey())) continue;
                    if (en.getValue() == null) continue;
                    for (String sv : en.getValue()) {
                        int eq = sv.indexOf('=');
                        if (eq <= 0) continue;
                        String name = sv.substring(0, eq).trim();
                        String val = sv.substring(eq + 1);
                        int sc = val.indexOf(';');
                        if (sc >= 0) val = val.substring(0, sc);
                        if (name.length() > 0 && val.length() > 0) jar.put(name, val);
                    }
                }
                httpCode = c.getResponseCode();
                if (httpCode >= 300 && httpCode < 400) {
                    String loc = c.getHeaderField("Location");
                    if (loc == null || loc.length() == 0) break;
                    url = loc.startsWith("http") ? loc
                        : ("https://pan.quark.cn" + (loc.startsWith("/") ? "" : "/") + loc);
                    continue;
                }
                InputStream is = httpCode >= 400 ? c.getErrorStream() : c.getInputStream();
                java.io.ByteArrayOutputStream b = new java.io.ByteArrayOutputStream();
                if (is != null) {
                    byte[] buf = new byte[4096]; int n;
                    while ((n = is.read(buf)) != -1) b.write(buf, 0, n);
                    is.close();
                }
                bodyText = new String(b.toByteArray(), "utf-8");
                break;
            }
        } catch (Throwable t) {
            json(sk, 200, "{\"ok\":false,\"message\":\"取登录态出错:" + esc(String.valueOf(t)) + "\"}");
            return;
        }
        boolean ok = jar.containsKey("__puus");
        String nick = "";
        try {
            JSONObject d = new JSONObject(bodyText).optJSONObject("data");
            if (d != null) nick = d.optString("nickname", d.optString("nick_name", ""));
        } catch (Throwable ignored) {}
        JSONObject o = new JSONObject();
        try {
            o.put("ok", ok);
            o.put("cookie", ok ? joinCookies(jar) : "");
            o.put("nickname", nick);
            o.put("http", httpCode);
            if (!ok) o.put("message", bodyText.length() > 220 ? bodyText.substring(0, 220) : bodyText);
        } catch (Throwable ignored) {}
        json(sk, 200, o.toString(), true);
    }

    private static String joinCookies(java.util.LinkedHashMap<String, String> jar) {
        StringBuilder sb = new StringBuilder();
        for (java.util.Map.Entry<String, String> e : jar.entrySet()) {
            if (sb.length() > 0) sb.append("; ");
            sb.append(e.getKey()).append('=').append(e.getValue());
        }
        return sb.toString();
    }

    /* 云盘直链流式输出(Range 透传) */
    private static void streamOut(Socket sk, String urlStr, String range, boolean quark) {
        try {
            HttpURLConnection c = (HttpURLConnection) new URL(urlStr).openConnection();
            c.setConnectTimeout(15000);
            c.setReadTimeout(60000);
            c.setRequestProperty("User-Agent", UA_PC);
            if (quark) c.setRequestProperty("Referer", "https://pan.quark.cn/");
            if (range != null) c.setRequestProperty("Range", range);
            int code = c.getResponseCode();
            String ct = c.getContentType();
            long len = c.getContentLength();
            OutputStream out = sk.getOutputStream();
            out.write(("HTTP/1.1 " + code + " \r\n" +
                "Content-Type: " + (ct == null ? "application/octet-stream" : ct) + "\r\n" +
                (len >= 0 ? "Content-Length: " + len + "\r\n" : "") +
                "Access-Control-Allow-Origin: *\r\n" +
                "Accept-Ranges: bytes\r\n" +
                (c.getHeaderField("Content-Range") != null ? "Content-Range: " + c.getHeaderField("Content-Range") + "\r\n" : "") +
                "Connection: close\r\n\r\n").getBytes());
            InputStream is = c.getInputStream();
            byte[] buf = new byte[65536]; int n;
            while ((n = is.read(buf)) != -1) { out.write(buf, 0, n); out.flush(); }
            is.close(); sk.close();
        } catch (Throwable t) {
            try { sk.close(); } catch (Exception ignored) {}
        }
    }

    private static String esc(String x) {
        return x.replace("\\", "\\\\").replace("\"", "\\\"").replace("\n", " ").replace("\r", " ");
    }
    /* 带会话 cookie 的请求:响应 Set-Cookie 累积进 jar */
    private static String httpTextJar(String method, String urlStr, String body, java.util.Map<String, String> headers, StringBuilder jar) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(urlStr).openConnection();
        c.setConnectTimeout(15000); c.setReadTimeout(30000);
        c.setRequestMethod(method);
        c.setRequestProperty("User-Agent", UA_PC);
        c.setRequestProperty("Referer", "https://subhd.tv/");
        if (headers != null) for (String k : headers.keySet()) c.setRequestProperty(k, headers.get(k));
        if (jar.length() > 0) c.setRequestProperty("Cookie", jar.toString());
        if (body != null) {
            c.setDoOutput(true);
            c.setRequestProperty("Content-Type", "application/json");
            c.getOutputStream().write(body.getBytes("utf-8"));
        }
        try {
            java.util.List<String> cookies = c.getHeaderFields().get("Set-Cookie");
            if (cookies != null) for (String ck : cookies) {
                String kv = ck.split(";", 2)[0];
                String k = kv.split("=", 2)[0];
                String cur = jar.toString();
                if (cur.contains(k + "=")) {
                    jar.setLength(0);
                    for (String part : cur.split("; ")) if (!part.startsWith(k + "=") && !part.isEmpty()) jar.append(part).append("; ");
                    jar.append(kv);
                } else {
                    if (jar.length() > 0) jar.append("; ");
                    jar.append(kv);
                }
            }
        } catch (Throwable ignored) {}
        int code = c.getResponseCode();
        return readAll(code >= 400 && c.getErrorStream() != null ? c.getErrorStream() : c.getInputStream());
    }
    private static String readAll(java.io.InputStream is) throws Exception {
        java.io.ByteArrayOutputStream b = new java.io.ByteArrayOutputStream();
        byte[] buf = new byte[8192]; int n;
        while ((n = is.read(buf)) != -1) b.write(buf, 0, n);
        is.close();
        return new String(b.toByteArray(), "utf-8");
    }
    private static String httpText(String method, String urlStr, String body, java.util.Map<String, String> headers) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(urlStr).openConnection();
        c.setConnectTimeout(15000); c.setReadTimeout(30000);
        c.setRequestMethod(method);
        c.setRequestProperty("User-Agent", UA_PC);
        if (headers != null) for (String k : headers.keySet()) c.setRequestProperty(k, headers.get(k));
        if (body != null) {
            c.setDoOutput(true);
            c.setRequestProperty("Content-Type", "application/json");
            c.getOutputStream().write(body.getBytes("utf-8"));
        }
        int code = c.getResponseCode();
        return readAll(code >= 400 && c.getErrorStream() != null ? c.getErrorStream() : c.getInputStream());
    }
    private static byte[] httpBytes(String urlStr) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(urlStr).openConnection();
        c.setConnectTimeout(15000); c.setReadTimeout(30000);
        c.setRequestProperty("User-Agent", UA_PC);
        return readAllBytes(c.getInputStream());
    }
    private static byte[] readAllBytes(java.io.InputStream is) throws Exception {
        java.io.ByteArrayOutputStream b = new java.io.ByteArrayOutputStream();
        byte[] buf = new byte[65536]; int n;
        while ((n = is.read(buf)) != -1) b.write(buf, 0, n);
        is.close();
        return b.toByteArray();
    }
    private static byte[] unzipSub(byte[] data) {
        try {
            if (data.length < 4 || data[0] != 'P' || data[1] != 'K') return data;
            java.util.zip.ZipInputStream zs = new java.util.zip.ZipInputStream(new java.io.ByteArrayInputStream(data));
            java.util.zip.ZipEntry e;
            while ((e = zs.getNextEntry()) != null) {
                if (e.getName().matches("(?i).*\\.(srt|ass|ssa|vtt)$")) return readAllBytes(zs);
            }
        } catch (Throwable ignored) {}
        return data;
    }
    private static java.util.Map<String, String> dandanHeaders(String appId, String appSecret, String ts, String p) throws Exception {
        javax.crypto.Mac mac = javax.crypto.Mac.getInstance("HmacSHA256");
        mac.init(new javax.crypto.spec.SecretKeySpec(appSecret.getBytes("utf-8"), "HmacSHA256"));
        String sig = android.util.Base64.encodeToString(
            mac.doFinal((appId + ts + p).getBytes("utf-8")), android.util.Base64.NO_WRAP);
        java.util.Map<String, String> h = new java.util.HashMap<>();
        h.put("X-AppId", appId); h.put("X-Timestamp", ts); h.put("X-Signature", sig);
        return h;
    }

    /* ---------------- U盘/本地存储 ---------------- */
    /* 已挂载的可读存储卷:/storage/XXXX(非 emulated/self) + 主存储 */
    private static String usbVolsJson() {
        StringBuilder b = new StringBuilder("{\"vols\":[");
        java.util.LinkedHashSet<String> seen = new java.util.LinkedHashSet<String>();
        try {
            java.io.File[] cands = new java.io.File("/storage").listFiles();
            if (cands != null) for (java.io.File f : cands) {
                String n = f.getName();
                if (!f.isDirectory() || n.startsWith("emulated") || n.startsWith("self") || n.startsWith("sdcard")) continue;
                java.io.File[] probe = f.listFiles();
                if (probe == null) continue;                  // 未挂载/无权限
                if (seen.add(f.getAbsolutePath())) {
                    String label = n.matches("[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}") ? "U盘 " + n : n;
                    b.append("{\"name\":\"").append(esc(label)).append("\",\"path\":\"").append(esc(f.getAbsolutePath())).append("\"},");
                }
            }
        } catch (Throwable ignored) {}
        try {
            java.io.File ext = android.os.Environment.getExternalStorageDirectory();
            if (ext != null && ext.isDirectory() && seen.add(ext.getAbsolutePath())) {
                b.append("{\"name\":\"内部存储\",\"path\":\"").append(esc(ext.getAbsolutePath())).append("\"},");
            }
        } catch (Throwable ignored) {}
        if (b.charAt(b.length() - 1) == ',') b.setLength(b.length() - 1);
        return b.append("]}").toString();
    }

    private static void usbList(Socket sk, String dirPath) {
        try {
            java.io.File dir = new java.io.File(dirPath == null || dirPath.isEmpty() ? "/" : dirPath);
            java.io.File[] fs = dir.listFiles();
            StringBuilder b = new StringBuilder("{\"error\":null,\"list\":[");
            if (fs != null) {
                java.util.Arrays.sort(fs, new java.util.Comparator<java.io.File>() {
                    public int compare(java.io.File a, java.io.File c) {
                        if (a.isDirectory() != c.isDirectory()) return a.isDirectory() ? -1 : 1;
                        return a.getName().compareToIgnoreCase(c.getName());
                    }
                });
                for (java.io.File f : fs) {
                    if (f.isHidden() || f.getName().startsWith(".")) continue;
                    if (b.charAt(b.length() - 1) != '[') b.append(',');
                    b.append("{\"name\":\"").append(esc(f.getName()))
                     .append("\",\"path\":\"").append(esc(f.getAbsolutePath().replace('\\', '/')))
                     .append("\",\"dir\":").append(f.isDirectory())
                     .append(",\"size\":").append(f.length()).append('}');
                }
            }
            b.append("]}");
            json(sk, 200, b.toString(), true);
        } catch (Throwable t) {
            json(sk, 200, "{\"error\":\"" + esc(String.valueOf(t.getMessage())) + "\",\"list\":[]}");
        }
    }

    /* 本地文件流式输出(Range 支持,4K 大文件可拖动) */
    private static void usbGet(Socket sk, String p, String range) {
        try {
            java.io.File f = new java.io.File(p == null ? "" : p);
            if (!f.isFile()) { json(sk, 404, "{\"error\":\"not found\"}"); return; }
            long total = f.length(), start = 0;
            if (range != null) {
                java.util.regex.Matcher m = java.util.regex.Pattern.compile("bytes=(\\d*)-").matcher(range);
                if (m.find() && !m.group(1).isEmpty()) start = Long.parseLong(m.group(1));
            }
            java.io.InputStream is = new java.io.FileInputStream(f);
            if (start > 0) is.skip(start);
            boolean partial = start > 0;
            OutputStream out = sk.getOutputStream();
            out.write(("HTTP/1.1 " + (partial ? "206 Partial Content" : "200 OK") + "\r\n" +
                "Content-Type: " + mimeOf(f.getName()) + "\r\n" +
                "Content-Length: " + (total - start) + "\r\n" +
                (partial ? "Content-Range: bytes " + start + "-" + (total - 1) + "/" + total + "\r\n" : "") +
                "Access-Control-Allow-Origin: *\r\n" +
                "Accept-Ranges: bytes\r\n" +
                "Connection: close\r\n\r\n").getBytes());
            byte[] buf = new byte[65536]; int n; long remain = total - start;
            while ((n = is.read(buf)) != -1 && remain > 0) {
                int w = (int) Math.min(n, remain);
                out.write(buf, 0, w);
                remain -= w;
                out.flush();
            }
            is.close(); sk.close();
        } catch (Throwable t) {
            try { sk.close(); } catch (Exception ignored) {}
        }
    }

    private static String mimeOf(String name) {
        String n = name.toLowerCase();
        if (n.endsWith(".mp4") || n.endsWith(".m4v")) return "video/mp4";
        if (n.endsWith(".webm")) return "video/webm";
        if (n.endsWith(".mkv")) return "video/x-matroska";
        if (n.endsWith(".ts") || n.endsWith(".m2ts")) return "video/mp2t";
        if (n.endsWith(".avi")) return "video/x-msvideo";
        if (n.endsWith(".mov")) return "video/quicktime";
        if (n.endsWith(".flv")) return "video/x-flv";
        if (n.endsWith(".m3u8")) return "application/vnd.apple.mpegurl";
        if (n.endsWith(".srt") || n.endsWith(".vtt")) return "text/plain; charset=utf-8";
        return "application/octet-stream";
    }

    private static String lanIp() {
        try {
            List<NetworkInterface> nis = Collections.list(NetworkInterface.getNetworkInterfaces());
            for (NetworkInterface ni : nis) {
                for (InetAddress a : Collections.list(ni.getInetAddresses())) {
                    String s = a.getHostAddress();
                    if (!a.isLoopbackAddress() && s.contains(".") && (s.startsWith("192.168.") || s.startsWith("10.") || s.startsWith("172."))) {
                        return s;
                    }
                }
            }
        } catch (Throwable ignored) {}
        return "127.0.0.1";
    }

    /* ================= 弹幕:B站内置(免凭证) =================
     * 2026-10 实测:search/type 不带 wbi 签名直接 412 风控,带 buvid3 + w_rid 正常;
     * nav 即使未登录(code -101)也会回 wbi_img,所以不需要账号/AppId。
     * 匹配策略:片名+集数搜 → 逐个看 view 的 pages(合集一集一个 P) → 时长校正 → 取该集 cid。 */
    private static final int[] BILI_TAB = {46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52};
    private static final java.util.regex.Pattern DM_DENY =
        java.util.regex.Pattern.compile("(解说|解析|影评|盘点|混剪|花絮|预告|片花|OST|主题曲|歌曲|音乐|有声|小说|合集|完整版)");
    private static String biliCookie = "", biliMixin = "";
    private static long biliAt = 0;
    private static String lastDmMatch = "";

    private static String md5Hex(String s) throws Exception {
        java.security.MessageDigest md = java.security.MessageDigest.getInstance("MD5");
        byte[] d = md.digest(s.getBytes("utf-8"));
        StringBuilder b = new StringBuilder();
        for (int i = 0; i < d.length; i++) b.append(String.format("%02x", d[i]));
        return b.toString();
    }

    private static String urlEnc(String s) throws Exception {
        return java.net.URLEncoder.encode(s, "utf-8").replace("+", "%20");
    }

    private static void bLog(String m) { android.util.Log.i("TVSRV", "[dm] " + m); }

    private static HttpURLConnection biliConn(String url) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setConnectTimeout(6000);
        c.setReadTimeout(15000);
        c.setRequestProperty("User-Agent", UA_PC);
        c.setRequestProperty("Referer", "https://www.bilibili.com/");
        if (!biliCookie.isEmpty()) c.setRequestProperty("Cookie", biliCookie);
        return c;
    }

    private static String biliGet(String url) throws Exception {
        long t0 = System.currentTimeMillis();
        try {
            HttpURLConnection c = biliConn(url);
            int code = c.getResponseCode();
            InputStream is = (code >= 400 && c.getErrorStream() != null) ? c.getErrorStream() : c.getInputStream();
            String s = readAll(is);
            bLog("GET " + url + " -> " + code + " " + (System.currentTimeMillis() - t0) + "ms len=" + s.length());
            return s;
        } catch (Throwable t) {
            bLog("GET FAIL " + url + " " + (System.currentTimeMillis() - t0) + "ms " + t);
            throw t;
        }
    }

    private static byte[] biliGetBytes(String url) throws Exception {
        long t0 = System.currentTimeMillis();
        try {
            HttpURLConnection c = biliConn(url);
            int code = c.getResponseCode();
            InputStream is = (code >= 400 && c.getErrorStream() != null) ? c.getErrorStream() : c.getInputStream();
            byte[] b = readAllBytes(is);
            bLog("GETB " + url + " -> " + code + " " + (System.currentTimeMillis() - t0) + "ms len=" + b.length);
            return b;
        } catch (Throwable t) {
            bLog("GETB FAIL " + url + " " + (System.currentTimeMillis() - t0) + "ms " + t);
            throw t;
        }
    }

    private static void biliPrep() throws Exception {
        if (!biliMixin.isEmpty() && System.currentTimeMillis() - biliAt < 30 * 60 * 1000) return;
        String b3 = "";
        try {
            JSONObject spi = new JSONObject(biliGet("https://api.bilibili.com/x/frontend/finger/spi"));
            b3 = spi.optJSONObject("data") == null ? "" : spi.optJSONObject("data").optString("b_3");
        } catch (Throwable ignored) {}
        if (!b3.isEmpty()) biliCookie = "buvid3=" + b3 + "; b_nut=" + (System.currentTimeMillis() / 1000);
        JSONObject nav = new JSONObject(biliGet("https://api.bilibili.com/x/web-interface/nav"));
        JSONObject img = nav.optJSONObject("data") == null ? null : nav.optJSONObject("data").optJSONObject("wbi_img");
        if (img == null) throw new Exception("B站 wbi 密钥获取失败");
        String iu = img.optString("img_url"), su = img.optString("sub_url");
        String raw = iu.substring(iu.lastIndexOf('/') + 1).split("\\.")[0] + su.substring(su.lastIndexOf('/') + 1).split("\\.")[0];
        if (raw.length() < 64) throw new Exception("B站 wbi 密钥格式异常");
        StringBuilder mix = new StringBuilder();
        for (int i = 0; i < BILI_TAB.length; i++) mix.append(raw.charAt(BILI_TAB[i]));
        biliMixin = mix.substring(0, 32);
        biliAt = System.currentTimeMillis();
    }

    private static String biliSigned(java.util.TreeMap<String, String> p) throws Exception {
        p.put("wts", String.valueOf(System.currentTimeMillis() / 1000));
        StringBuilder q = new StringBuilder();
        for (String k : p.keySet()) {
            if (q.length() > 0) q.append('&');
            q.append(urlEnc(k)).append('=').append(urlEnc(p.get(k)));
        }
        return q + "&w_rid=" + md5Hex(q.toString() + biliMixin);
    }

    private static int cnNum(String s) {
        String d = "零一二三四五六七八九";
        int n = 0, cur = 0;
        for (int i = 0; i < s.length(); i++) {
            char ch = s.charAt(i);
            int di = d.indexOf(ch);
            if (di >= 0) cur = di;
            else if (ch == '十') { n += (cur == 0 ? 1 : cur) * 10; cur = 0; }
            else if (ch == '百') { n += (cur == 0 ? 1 : cur) * 100; cur = 0; }
            else if (ch == '两') cur = 2;
            else return 0;
        }
        return n + cur;
    }

    private static int epNoOf(String t) {
        if (t == null) return 0;
        java.util.regex.Matcher m = java.util.regex.Pattern.compile("第\\s*0*(\\d+)\\s*[集话話期]").matcher(t);
        if (m.find()) { try { return Integer.parseInt(m.group(1)); } catch (Throwable ignored) {} }
        m = java.util.regex.Pattern.compile("第\\s*([零一二三四五六七八九十百两]{1,5})\\s*[集话話期]").matcher(t);
        if (m.find()) return cnNum(m.group(1));
        return 0;
    }

    private static double durSec(String d) {
        if (d == null || d.isEmpty()) return 0;
        String[] a = d.split(":");
        try {
            if (a.length == 3) return Integer.parseInt(a[0].trim()) * 3600 + Integer.parseInt(a[1].trim()) * 60 + Integer.parseInt(a[2].trim());
            if (a.length == 2) return Integer.parseInt(a[0].trim()) * 60 + Integer.parseInt(a[1].trim());
            return Double.parseDouble(a[0].trim());
        } catch (Throwable e) { return 0; }
    }

    private static boolean durClose(double a, double b, double tol) {
        if (a <= 0 || b <= 0) return false;
        return Math.abs(a - b) / Math.max(a, b) <= tol;
    }

    private static org.json.JSONArray biliSearch(String kw) throws Exception {
        for (int attempt = 0; attempt < 2; attempt++) {
            java.util.TreeMap<String, String> p = new java.util.TreeMap<>();
            p.put("search_type", "video");
            p.put("keyword", kw);
            p.put("page", "1");
            String url = "https://api.bilibili.com/x/web-interface/wbi/search/type?" + biliSigned(p);
            JSONObject j;
            try { j = new JSONObject(biliGet(url)); }
            catch (Throwable e) {
                if (attempt == 0) { biliMixin = ""; try { biliPrep(); } catch (Throwable ignored) {} continue; }
                return new org.json.JSONArray();
            }
            int code = j.optInt("code", 0);
            if (code == -412 || code == -403) {
                biliMixin = "";
                try { biliPrep(); } catch (Throwable ignored) {}
                continue;
            }
            JSONObject data = j.optJSONObject("data");
            org.json.JSONArray arr = data == null ? null : data.optJSONArray("result");
            return arr == null ? new org.json.JSONArray() : arr;
        }
        return new org.json.JSONArray();
    }

    /* 返回该集弹幕 XML;匹配不到返回 null(宁缺毋滥) */
    /* ---------- 公益弹幕:弹弹play 兼容免凭证代理 ----------
     * 链路(全部 GET,无需 AppId/Secret,代理侧自己完成弹弹play鉴权):
     *   GET {base}/api/v2/search/anime?keyword=<片名>  → animes[0].animeId
     *   GET {base}/api/v2/bangumi/{animeId}            → bangumi.episodes[] (episodeNumber/episodeTitle)
     *   GET {base}/api/v2/comment/{episodeId}?withRelated=true&chConvert=1
     * comments[].p = "秒,模式,颜色,用户hash"(与 B 站 XML p 属性兼容), .m = 弹幕文本。
     * p 原样输出给前端 parseXML,不需要 shift 换算。 */
    private static final String GY_BASE_DEFAULT = "https://danmaku-api.152468.xyz";

    private static String gongyiDm(String name, String ep, String base) throws Exception {
        if (base == null || base.trim().isEmpty()) base = GY_BASE_DEFAULT;
        base = base.trim().replaceAll("/+$", "");
        java.util.Map<String, String> h = new java.util.HashMap<>();
        h.put("User-Agent", "AMUTV/1.4");
        h.put("Accept", "application/json");
        org.json.JSONObject s = new org.json.JSONObject(httpText("GET",
            base + "/api/v2/search/anime?keyword=" + java.net.URLEncoder.encode(name, "utf-8"), null, h));
        org.json.JSONArray as = s.optJSONArray("animes");
        if (as == null || as.length() == 0) return null;
        long aid = 0;
        for (int i = 0; i < as.length() && i < 3; i++) {
            org.json.JSONObject a0 = as.optJSONObject(i);
            if (a0 != null && a0.optLong("animeId", 0) > 0) { aid = a0.optLong("animeId"); break; }
        }
        if (aid <= 0) return null;
        org.json.JSONObject bg = new org.json.JSONObject(httpText("GET", base + "/api/v2/bangumi/" + aid, null, h))
            .optJSONObject("bangumi");
        if (bg == null) return null;
        org.json.JSONArray eps = bg.optJSONArray("episodes");
        if (eps == null || eps.length() == 0) return null;
        int want = epNoOf(ep);
        org.json.JSONObject pick = null;
        for (int i = 0; i < eps.length(); i++) {
            org.json.JSONObject e0 = eps.optJSONObject(i);
            if (e0 == null) continue;
            int n = 0;
            try { n = Integer.parseInt(e0.optString("episodeNumber", "").trim()); } catch (Exception ignored) {}
            if (n <= 0) n = epNoOf(e0.optString("episodeTitle", ""));
            if (want > 0 && n == want) { pick = e0; break; }
        }
        if (pick == null && want > 0 && eps.length() >= want) pick = eps.optJSONObject(want - 1);
        if (pick == null && want <= 0) pick = eps.optJSONObject(0);
        if (pick == null) return null;
        long eid = pick.optLong("episodeId", 0);
        if (eid <= 0) return null;
        lastDmMatch = bg.optString("animeTitle", "") + " · " + pick.optString("episodeTitle", "");
        org.json.JSONObject cc = new org.json.JSONObject(httpText("GET",
            base + "/api/v2/comment/" + eid + "?withRelated=true&chConvert=1", null, h));
        org.json.JSONArray cs = cc.optJSONArray("comments");
        if (cs == null || cs.length() == 0) return null;
        StringBuilder b = new StringBuilder("<?xml version=\"1.0\"?><i>");
        for (int i = 0; i < cs.length(); i++) {
            org.json.JSONObject cm = cs.optJSONObject(i);
            if (cm == null) continue;
            String p = cm.optString("p", "").trim();
            String m = cm.optString("m", "").trim();
            if (!p.isEmpty() && !m.isEmpty()) {
                b.append("<d p=\"").append(esc(p)).append("\">").append(esc(m)).append("</d>");
            }
        }
        return b.append("</i>").toString();
    }

    private static String biliDm(String name, String ep, double targetDur) throws Exception {
        long t0 = System.currentTimeMillis();
        biliPrep();
        bLog("prep done " + (System.currentTimeMillis() - t0) + "ms cookie=" + (biliCookie.isEmpty() ? "empty" : "set") + " mixin=" + (biliMixin.isEmpty() ? "empty" : "ok"));
        final int epNo = epNoOf(ep);
        java.util.LinkedHashSet<String> kws = new java.util.LinkedHashSet<>();
        if (ep != null && ep.matches(".*第\\s*\\d+\\s*[集话話期].*")) kws.add((name + " " + ep).trim());
        if (epNo > 0) kws.add(name + " 第" + epNo + "集");
        kws.add(name);

        java.util.List<JSONObject> cands = new java.util.ArrayList<>();
        java.util.Set<String> seen = new java.util.HashSet<>();
        for (String kw : kws) {
            org.json.JSONArray arr = biliSearch(kw);
            bLog("search \"" + kw + "\" -> " + (arr == null ? 0 : arr.length()) + " @" + (System.currentTimeMillis() - t0) + "ms");
            for (int i = 0; arr != null && i < arr.length(); i++) {
                JSONObject it = arr.optJSONObject(i);
                if (it == null) continue;
                String bv = it.optString("bvid");
                if (bv.isEmpty() || seen.contains(bv)) continue;
                seen.add(bv);
                cands.add(it);
            }
            if (cands.size() >= 12) break;
        }
        if (cands.isEmpty()) return null;

        final double td = targetDur;
        Collections.sort(cands, new java.util.Comparator<JSONObject>() {
            public int compare(JSONObject a, JSONObject b) {
                int ta = (epNo > 0 && epNoOf(a.optString("title")) == epNo) ? 1 : 0;
                int tb = (epNo > 0 && epNoOf(b.optString("title")) == epNo) ? 1 : 0;
                if (ta != tb) return tb - ta;
                if (td > 0) {
                    double fa = Math.abs(durSec(a.optString("duration")) - td) / td;
                    double fb = Math.abs(durSec(b.optString("duration")) - td) / td;
                    if (Math.abs(fa - fb) > 0.2) return fa < fb ? -1 : 1;
                }
                return b.optLong("play") > a.optLong("play") ? 1 : -1;
            }
        });

        double bestSc = -1;
        String bestCid = null, bestTitle = "", bestTag = "";
        double bestDur = 0;
        for (int i = 0; i < cands.size() && i < 6; i++) {
            JSONObject it = cands.get(i);
            String title = it.optString("title").replaceAll("<[^>]+>", "");
            int titleEp = epNoOf(title);
            String bv = it.optString("bvid");
            if (bv.isEmpty()) continue;
            JSONObject data;
            try { data = new JSONObject(biliGet("https://api.bilibili.com/x/web-interface/view?bvid=" + bv)).optJSONObject("data"); }
            catch (Throwable e) { continue; }
            if (data == null) continue;
            org.json.JSONArray pages = data.optJSONArray("pages");
            String cid = null, tag = "";
            double sc = -1, pdur = 0;
            if (pages != null && pages.length() > 1) {
                JSONObject pg = null;
                if (epNo > 0) {
                    for (int k = 0; k < pages.length(); k++) {
                        JSONObject o = pages.optJSONObject(k);
                        if (o != null && epNoOf(o.optString("part")) == epNo) { pg = o; break; }
                    }
                    if (pg == null && pages.length() >= epNo) pg = pages.optJSONObject(epNo - 1);
                }
                if (pg == null && td > 0) {
                    double bd = -1;
                    for (int k = 0; k < pages.length(); k++) {
                        JSONObject o = pages.optJSONObject(k);
                        if (o == null) continue;
                        double diff = Math.abs(o.optDouble("duration") - td);
                        if (bd < 0 || diff < bd) { bd = diff; pg = o; }
                    }
                }
                if (pg == null) continue;
                pdur = pg.optDouble("duration");
                if (td > 0 && !durClose(pdur, td, 0.15)) continue;
                cid = pg.optString("cid");
                int pno = pg.optInt("page", 1);
                tag = pno > 1 ? " · P" + pno : "";
                sc = 2 + (td > 0 ? (1 - Math.abs(pdur - td) / td) : 0.5);
                if (epNo > 0 && epNoOf(pg.optString("part")) == epNo) sc += 1;
            } else {
                if (epNo > 0 && titleEp != epNo) continue;
                if (DM_DENY.matcher(title).find()) continue;
                double vd = data.optDouble("duration");
                if (td > 0 && !durClose(vd, td, 0.15)) continue;
                cid = data.optString("cid");
                pdur = vd;
                sc = 2 + (td > 0 ? (1 - Math.abs(vd - td) / td) : 0.3) + (epNo > 0 && titleEp == epNo ? 1.2 : 0);
            }
            if (cid == null || cid.isEmpty()) continue;
            if (sc > bestSc) { bestSc = sc; bestCid = cid; bestTitle = title; bestTag = tag; bestDur = pdur; }
        }
        if (bestCid == null) { bLog("no match, total " + (System.currentTimeMillis() - t0) + "ms"); return null; }
        bLog("best=" + bestTitle + bestTag + " cid=" + bestCid + " @" + (System.currentTimeMillis() - t0) + "ms, fetching list.so");
        String xml = inflateText(biliGetBytes("https://api.bilibili.com/x/v1/dm/list.so?oid=" + bestCid));
        bLog("list.so done, xml=" + xml.length() + " @" + (System.currentTimeMillis() - t0) + "ms");
        if (!xml.contains("<d p=")) return null;
        lastDmMatch = bestTitle + bestTag + (bestDur > 0 ? " · " + Math.round(bestDur / 60) + "分" : "");
        return xml;
    }

    /* dm/list.so 固定回 deflate,Java 不会自动解,这里两种都试一遍 */
    private static String inflateText(byte[] data) {
        String s = new String(data, java.nio.charset.StandardCharsets.UTF_8);
        if (s.trim().startsWith("<")) return s;
        for (int raw = 0; raw < 2; raw++) {
            try {
                java.util.zip.Inflater inf = new java.util.zip.Inflater(raw == 1);
                inf.setInput(data);
                java.io.ByteArrayOutputStream bo = new java.io.ByteArrayOutputStream();
                byte[] buf = new byte[65536];
                while (!inf.finished()) {
                    int n = inf.inflate(buf);
                    if (n == 0) break;
                    bo.write(buf, 0, n);
                }
                inf.end();
                String out = new String(bo.toByteArray(), "utf-8");
                if (out.contains("<")) return out;
            } catch (Throwable ignored) {}
        }
        return s;
    }
}
