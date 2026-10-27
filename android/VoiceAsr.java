package tv.yingshi.app;

import android.content.Context;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.Charset;

/**
 * 云端 ASR 上传(原生 HTTP,multipart/form-data)。
 *
 * 为什么不直接在网页里 fetch:
 *   App 页面是 file:///android_asset/..., 往外部域名 POST 属于跨域请求。
 *   自建 ASR(如兼容 OpenAI 的网关)一般会带 CORS 头,但官方 OpenAI / 讯飞 / 阿里
 *   都不允许浏览器直连,请求会被 WebView 拦掉,报错还看不出是 CORS。
 *   走原生 HttpURLConnection 没有这个限制,也不会被混合内容策略挡。
 *
 * 只做「上传 + 原样返回响应体」,解析交给网页(前端已兼容 Whisper/国内各家格式)。
 */
public class VoiceAsr {

    private static final int CONNECT_MS = 12000;
    private static final int READ_MS = 30000;
    private static final String B = "----tvboxAsrBoundary7d3";

    public interface Cb { void onDone(JSONObject r); }

    public static void upload(final Context c, final String url, final String key,
                              final String model, final String lang, final Cb cb) {
        final JSONObject o = new JSONObject();
        try {
            if (url == null || !(url.startsWith("http://") || url.startsWith("https://"))) {
                o.put("ok", false); o.put("err", "接口地址要以 http(s):// 开头");
                if (cb != null) cb.onDone(o);
                return;
            }
            File f = VoiceRec.wavFile(c);
            if (!f.exists() || f.length() == 0) {
                o.put("ok", false); o.put("err", "没有录到音频");
                if (cb != null) cb.onDone(o);
                return;
            }
        } catch (Throwable t) {
            if (cb != null) cb.onDone(o);
            return;
        }

        new Thread(new Runnable() {
            public void run() {
                JSONObject r = doUpload(c, url, key, model, lang);
                if (cb != null) cb.onDone(r);
            }
        }, "voice-asr").start();
    }

    private static JSONObject doUpload(Context c, String urlStr, String key, String model, String lang) {
        JSONObject o = new JSONObject();
        HttpURLConnection conn = null;
        try {
            byte[] wav = readAll(VoiceRec.wavFile(c));
            if (wav.length == 0) { o.put("ok", false); o.put("err", "音频文件为空"); return o; }

            ByteArrayOutputStream body = new ByteArrayOutputStream(wav.length + 2048);
            put(body, "--" + B + "\r\n");
            put(body, "Content-Disposition: form-data; name=\"file\"; filename=\"voice.wav\"\r\n");
            put(body, "Content-Type: audio/wav\r\n\r\n");
            body.write(wav);
            put(body, "\r\n");
            if (model != null && model.length() > 0) {
                put(body, "--" + B + "\r\n");
                put(body, "Content-Disposition: form-data; name=\"model\"\r\n\r\n");
                put(body, model + "\r\n");
            }
            if (lang != null && lang.length() > 0) {
                /* 同时给 language / lang 两个字段名:Whisper 用 language,
                 * 国内不少接口用 lang,多给一个不影响对方解析 */
                put(body, "--" + B + "\r\n");
                put(body, "Content-Disposition: form-data; name=\"language\"\r\n\r\n");
                put(body, lang + "\r\n");
                put(body, "--" + B + "\r\n");
                put(body, "Content-Disposition: form-data; name=\"lang\"\r\n\r\n");
                put(body, lang + "\r\n");
            }
            put(body, "--" + B + "--\r\n");
            byte[] payload = body.toByteArray();

            URL u = new URL(urlStr);
            conn = (HttpURLConnection) u.openConnection();
            conn.setConnectTimeout(CONNECT_MS);
            conn.setReadTimeout(READ_MS);
            conn.setRequestMethod("POST");
            conn.setDoOutput(true);
            conn.setRequestProperty("Content-Type", "multipart/form-data; boundary=" + B);
            conn.setRequestProperty("Content-Length", String.valueOf(payload.length));
            conn.setRequestProperty("Accept", "application/json, text/plain, */*");
            if (key != null && key.length() > 0) {
                conn.setRequestProperty("Authorization", "Bearer " + key);
            }
            OutputStream os = conn.getOutputStream();
            os.write(payload);
            os.flush();
            os.close();

            int code = conn.getResponseCode();
            InputStream in = (code >= 200 && code < 400) ? conn.getInputStream() : conn.getErrorStream();
            String text = in == null ? "" : new String(readAll(in), Charset.forName("UTF-8"));
            o.put("ok", code >= 200 && code < 400);
            o.put("code", code);
            o.put("text", text.length() > 20000 ? text.substring(0, 20000) : text);
            if (code < 200 || code >= 400) o.put("err", "HTTP " + code);
            return o;
        } catch (Throwable t) {
            try {
                o.put("ok", false);
                o.put("err", String.valueOf(t.getMessage()));
            } catch (Throwable ignored) {}
            return o;
        } finally {
            try { if (conn != null) conn.disconnect(); } catch (Throwable ignored) {}
        }
    }

    private static void put(ByteArrayOutputStream b, String s) throws Exception {
        b.write(s.getBytes("UTF-8"));
    }

    private static byte[] readAll(File f) throws Exception {
        FileInputStream in = new FileInputStream(f);
        try { return readAll(in); } finally { try { in.close(); } catch (Throwable ignored) {} }
    }

    private static byte[] readAll(InputStream in) throws Exception {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] b = new byte[8192];
        int n;
        while ((n = in.read(b)) > 0) out.write(b, 0, n);
        return out.toByteArray();
    }
}
