# -*- coding: utf-8 -*-
import io

p = r'C:\Users\91596\.zcode\workspace\17e4ecba-c7c4-40ce-b117-87a9e9f578b3\tvbox-web\android\MainActivity.java'
s = io.open(p, encoding='utf-8').read()

# 1) 字段
s = s.replace("""public class MainActivity extends Activity {
    private WebView wv;""",
"""public class MainActivity extends Activity {
    private WebView wv;
    private android.net.Uri pickedUri = null;
    private Thread streamSrv = null;
    private android.webkit.ValueCallback<android.net.Uri[]> fileCb = null;""")

# 2) onShowFileChooser:网页 input[type=file] → 系统文件选择(U盘/本地)
s = s.replace("""        wv.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onConsoleMessage(android.webkit.ConsoleMessage m) {
                android.util.Log.i("TVJS", m.message() + " @" + m.sourceId() + ":" + m.lineNumber());
                return true;
            }
        });""",
"""        wv.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onConsoleMessage(android.webkit.ConsoleMessage m) {
                android.util.Log.i("TVJS", m.message() + " @" + m.sourceId() + ":" + m.lineNumber());
                return true;
            }

            /* U盘/本地文件即插即播:网页 file input → 系统文件选择器 */
            @Override
            public boolean onShowFileChooser(WebView view, android.webkit.ValueCallback<android.net.Uri[]> cb, FileChooserParams params) {
                fileCb = cb;
                try {
                    android.content.Intent i = new android.content.Intent(android.content.Intent.ACTION_OPEN_DOCUMENT);
                    i.addCategory(android.content.Intent.CATEGORY_OPENABLE);
                    i.setType("video/*");
                    startActivityForResult(i, 101);
                    return true;
                } catch (Throwable t) {
                    return false;
                }
            }
        });""")

# 3) onActivityResult:注册 content Uri + 启动流服务 + 回调 JS
s = s.replace("""    /* 返回键:网页有历史则回退,否则退出 */""",
"""    @Override
    protected void onActivityResult(int req, int res, android.content.Intent data) {
        if (req == 101) {
            if (res == android.app.Activity.RESULT_OK && data != null && data.getData() != null) {
                pickedUri = data.getData();
                try {
                    getContentResolver().takePersistableUriPermission(pickedUri,
                            android.content.Intent.FLAG_GRANT_READ_URI_PERMISSION);
                } catch (Throwable t) {}
                startStreamServer();
                if (wv != null) wv.evaluateJavascript(
                        "window.__onLocalFile && window.__onLocalFile('http://127.0.0.1:9979/stream?t=" + System.currentTimeMillis() + "')", null);
            } else if (fileCb != null) {
                fileCb.onReceiveValue(null);
                fileCb = null;
            }
        }
    }

    /* 本地/U盘内容流服务:content:// → 127.0.0.1:9979/stream(HTTP,支持 Range 拖动) */
    private void startStreamServer() {
        if (streamSrv != null && streamSrv.isAlive()) return;
        streamSrv = new Thread(new Runnable() {
            public void run() {
                try {
                    java.net.ServerSocket ss = new java.net.ServerSocket(9979, 64,
                            java.net.InetAddress.getByName("127.0.0.1"));
                    while (true) {
                        final java.net.Socket sk = ss.accept();
                        new Thread(new Runnable() { public void run() { serveOne(sk); } }).start();
                    }
                } catch (Throwable t) {
                    android.util.Log.e("TVDBG", "stream srv: " + t);
                }
            }
        });
        streamSrv.start();
    }

    private void serveOne(java.net.Socket sk) {
        try {
            java.io.BufferedReader in = new java.io.BufferedReader(new java.io.InputStreamReader(sk.getInputStream()));
            String line = in.readLine();
            long start = 0;
            while (line != null && line.length() > 0) {
                if (line.toLowerCase().startsWith("range:")) {
                    java.util.regex.Matcher m = java.util.regex.Pattern.compile("bytes=(\\\\d*)-").matcher(line);
                    if (m.find() && !m.group(1).isEmpty()) start = Long.parseLong(m.group(1));
                }
                line = in.readLine();
            }
            java.io.OutputStream out = new java.io.BufferedOutputStream(sk.getOutputStream());
            if (pickedUri == null) { out.write("HTTP/1.1 404 Not Found\\r\\n\\r\\n".getBytes()); out.flush(); sk.close(); return; }
            long total = querySize(pickedUri);
            java.io.InputStream is = getContentResolver().openInputStream(pickedUri);
            if (start > 0) is.skip(start);
            boolean partial = start > 0;
            out.write(("HTTP/1.1 " + (partial ? "206 Partial Content" : "200 OK") + "\\r\\n" +
                    "Content-Type: video/mp4\\r\\n" +
                    "Content-Length: " + (total - start) + "\\r\\n" +
                    (partial ? "Content-Range: bytes " + start + "-" + (total - 1) + "/" + total + "\\r\\n" : "") +
                    "Accept-Ranges: bytes\\r\\n\\r\\n").getBytes());
            byte[] buf = new byte[65536];
            int n;
            long sent = 0, remain = total - start;
            while ((n = is.read(buf)) != -1 && remain > 0) {
                out.write(buf, 0, (int) Math.min(n, remain));
                sent += n;
                remain -= n;
            }
            out.flush();
            is.close();
            sk.close();
        } catch (Throwable t) {
            try { sk.close(); } catch (_t) {}
        }
    }

    private long querySize(android.net.Uri uri) {
        try {
            android.database.Cursor c = getContentResolver().query(uri, null, null, null, null);
            if (c != null) {
                int idx = c.getColumnIndex(android.provider.OpenableColumns.SIZE);
                long size = 0;
                if (c.moveToFirst() && idx >= 0) size = c.getLong(idx);
                c.close();
                if (size > 0) return size;
            }
        } catch (Throwable t) {}
        return Long.MAX_VALUE / 4; // 未知大小时给足余量,靠流结束自然收尾
    }

    /* 返回键:网页有历史则回退,否则退出 */""")

io.open(p, 'w', encoding='utf-8').write(s)
print('android local-file bridge added')
