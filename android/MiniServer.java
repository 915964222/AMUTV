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

            route(sk, method, path, query, body.toString(), range);
        } catch (Throwable t) {
            try { sk.close(); } catch (Exception ignored) {}
        }
    }

    private static void json(Socket sk, int code, String body) {
        reply(sk, code, "application/json; charset=utf-8", body.getBytes());
    }

    private static void reply(Socket sk, int code, String ctype, byte[] data) {
        try {
            OutputStream out = sk.getOutputStream();
            out.write(("HTTP/1.1 " + code + " OK\r\n" +
                "Content-Type: " + ctype + "\r\n" +
                "Content-Length: " + data.length + "\r\n" +
                "Access-Control-Allow-Origin: *\r\n" +
                "Access-Control-Allow-Headers: *\r\n" +
                "Access-Control-Allow-Methods: GET,POST,OPTIONS\r\n" +
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
            c.setRequestProperty("Referer", "https://pan.quark.cn/");
            if (bearer != null) c.setRequestProperty("Authorization", bearer);
            if (cookie != null && !cookie.isEmpty()) c.setRequestProperty("Cookie", cookie);
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
            reply(sk, code < 400 ? 200 : 502, "application/json; charset=utf-8", b.toByteArray());
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
