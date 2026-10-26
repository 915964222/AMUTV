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
    private static void serve(Socket sk) {
        try {
            BufferedReader in = new BufferedReader(new InputStreamReader(sk.getInputStream()));
            String reqLine = in.readLine();
            if (reqLine == null) { sk.close(); return; }
            String[] parts = reqLine.split(" ");
            String method = parts[0];
            String pathQ = parts.length > 1 ? parts[1] : "/";
            int qi = pathQ.indexOf('?');
            String path = qi >= 0 ? pathQ.substring(0, qi) : pathQ;
            String query = qi >= 0 ? pathQ.substring(qi + 1) : "";

            int clen = 0; String range = null;
            String line;
            while ((line = in.readLine()) != null && line.length() > 0) {
                String low = line.toLowerCase();
                if (low.startsWith("content-length:")) clen = Integer.parseInt(line.substring(15).trim());
                if (low.startsWith("range:")) range = line.substring(6).trim();
            }
            StringBuilder body = new StringBuilder();
            for (int i = 0; i < clen; i++) body.append((char) in.read());
            try { android.util.Log.i("TVSRV", method + " " + path + (query.isEmpty() ? "" : "?" + query.substring(0, Math.min(60, query.length())))); } catch (Throwable ignored) {}

            route(sk, method, path, query, body.toString(), range);
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
            if (path.equals("/cloud/dl")) {
                String target = qp(query, "u");
                boolean quark = "1".equals(qp(query, "h"));
                streamOut(sk, target, range, quark); return;
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
                    if (fileName.isEmpty()) { json(sk, 200, "{\"error\":\"缺少文件名\"}"); return; }
                    String tpl = q0.optString("tpl", "");
                    String xml = null;
                    if (tpl.startsWith("http")) {
                        String u = tpl.replace("{fileName}", java.net.URLEncoder.encode(fileName, "utf-8"))
                                      .replace("{filename}", java.net.URLEncoder.encode(fileName, "utf-8"));
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
                    } else {
                        String appId = q0.optString("appId", ""), appSecret = q0.optString("appSecret", "");
                        if (appId.isEmpty() || appSecret.isEmpty()) {
                            json(sk, 200, "{\"error\":\"弹弹play官方接口需 AppId/AppSecret,或使用自定义接口模板\"}");
                            return;
                        }
                        String ts = String.valueOf(System.currentTimeMillis() / 1000);
                        String mp = "/api/v2/match";
                        org.json.JSONObject mm = new org.json.JSONObject(httpText("POST", "https://api.dandanplay.net" + mp,
                            "{\"fileName\":\"" + esc(fileName) + "\",\"fileHash\":\"\",\"fileSize\":0,\"videoDuration\":0,\"matchMode\":1}",
                            dandanHeaders(appId, appSecret, ts, mp)));
                        if (!mm.optBoolean("isMatched")) { json(sk, 200, "{\"error\":\"未匹配到弹幕\"}"); return; }
                        String epId = mm.getJSONArray("matches").getJSONObject(0).optString("episodeId", "");
                        String cp = "/api/v2/comment/" + epId + "?withRelated=true&chConvert=1";
                        org.json.JSONObject cc = new org.json.JSONObject(httpText("GET", "https://api.dandanplay.net" + cp, null,
                            dandanHeaders(appId, appSecret, ts, cp)));
                        if (!cc.has("comments")) { json(sk, 200, "{\"error\":\"弹幕拉取失败\"}"); return; }
                        StringBuilder b = new StringBuilder("<?xml version=\"1.0\"?><i>");
                        org.json.JSONArray cs = cc.getJSONArray("comments");
                        for (int i = 0; i < cs.length(); i++) {
                            org.json.JSONObject cm = cs.getJSONObject(i);
                            double sh = cm.optDouble("shift", 0);
                            b.append("<d p=\"").append(sh).append(",1,25,16777215,").append((long) (sh * 1000)).append(",0,0,0\">")
                             .append(esc(cm.optString("p", ""))).append("</d>");
                        }
                        xml = b.append("</i>").toString();
                    }
                    json(sk, 200, "{\"xml\":\"" + esc(xml.substring(0, Math.min(xml.length(), 3000000))) + "\"}");
                } catch (Throwable t) { json(sk, 502, "{\"error\":\"" + t.getMessage() + "\"}"); }
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
            /* 目标本身就是媒体文件 → 已是直链 */
            if (ctype.contains("mpegurl") || ctype.contains("video/mp4") || ctype.contains("application/x-mpegurl")) {
                json(sk, 200, "{\"ok\":true,\"direct\":true,\"urls\":[\"" + jsonEsc(finalUrl) + "\"]}");
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
            StringBuilder sb = new StringBuilder();
            sb.append("{\"ok\":true,\"urls\":[");
            for (int i = 0; i < ok.size(); i++) {
                if (i > 0) sb.append(",");
                sb.append("\"").append(jsonEsc(ok.get(i))).append("\"");
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
}
