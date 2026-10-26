package tv.yingshi.app;

import android.app.Activity;
import android.os.Bundle;
import android.view.KeyEvent;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.graphics.Color;

public class MainActivity extends Activity {
    private WebView wv;
    private android.net.Uri pickedUri = null;
    private Thread streamSrv = null;
    private android.webkit.ValueCallback<android.net.Uri[]> fileCb = null;
    private static final String INDEX_URL = "file:///android_asset/www_index.html";

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        MiniServer.start(this);   // 局域网遥控/推送/云盘中转(0.0.0.0:9978)

        /* U盘/存储插拔监听:即插即播,挂载/卸载时通知网页(运行期注册在 Android 11+ 仍可收到) */
        try {
            android.content.IntentFilter uf = new android.content.IntentFilter();
            uf.addAction(android.content.Intent.ACTION_MEDIA_MOUNTED);
            uf.addAction(android.content.Intent.ACTION_MEDIA_UNMOUNTED);
            uf.addAction(android.content.Intent.ACTION_MEDIA_EJECT);
            uf.addAction(android.content.Intent.ACTION_MEDIA_REMOVED);
            uf.addDataScheme("file");
            registerReceiver(new android.content.BroadcastReceiver() {
                @Override
                public void onReceive(android.content.Context c, android.content.Intent i) {
                    boolean mounted = android.content.Intent.ACTION_MEDIA_MOUNTED.equals(i.getAction());
                    if (wv != null) wv.evaluateJavascript(
                            "window.__onUsb && window.__onUsb(" + mounted + ")", null);
                }
            }, uf);
        } catch (Throwable t) {
            android.util.Log.e("TVDBG", "usb receiver: " + t);
        }

        wv = new WebView(this);
        wv.setBackgroundColor(Color.parseColor("#070b14"));
        WebSettings s = wv.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        // file:// 通用访问:免代理直连任意源(本应用核心跨域方案)
        s.setAllowUniversalAccessFromFileURLs(true);
        s.setAllowFileAccessFromFileURLs(true);
        s.setAllowFileAccess(true);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        s.setUserAgentString("Mozilla/5.0 (Linux; Android 12; SMART-TV) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36");
        CookieManager.getInstance().setAcceptCookie(true);

        wv.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
                return false; // 全部在 WebView 内打开
            }

            /* 渲染进程崩溃(视频解码内存压力)时自动重建 WebView,而不是整个应用退出 */
            @Override
            public boolean onRenderProcessGone(WebView view, android.webkit.RenderProcessGoneDetail detail) {
                android.util.Log.e("TVDBG", "renderer gone: " + detail.didCrash() + ", rebuilding webview");
                rebuild();
                return true; // 已处理,不再杀掉应用
            }
        });
        wv.setWebChromeClient(new WebChromeClient() {
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
        });
        wv.addJavascriptInterface(new Object() {
            /* 遥控软键盘:网页自绘键盘接管输入,这里负责压住/唤起系统输入法 */
            @android.webkit.JavascriptInterface
            public void showIme() {
                runOnUiThread(new Runnable() {
                    public void run() {
                        try {
                            if (wv == null) return;
                            wv.requestFocus();
                            android.view.inputmethod.InputMethodManager imm =
                                    (android.view.inputmethod.InputMethodManager) getSystemService(INPUT_METHOD_SERVICE);
                            if (imm != null) imm.showSoftInput(wv, android.view.inputmethod.InputMethodManager.SHOW_IMPLICIT);
                        } catch (Throwable t) {}
                    }
                });
            }

            @android.webkit.JavascriptInterface
            public void hideIme() {
                runOnUiThread(new Runnable() {
                    public void run() {
                        try {
                            if (wv == null) return;
                            android.view.inputmethod.InputMethodManager imm =
                                    (android.view.inputmethod.InputMethodManager) getSystemService(INPUT_METHOD_SERVICE);
                            if (imm != null) imm.hideSoftInputFromWindow(wv.getWindowToken(), 0);
                        } catch (Throwable t) {}
                    }
                });
            }

            @android.webkit.JavascriptInterface
            public String fetchText(String url, String referer) {
                try {
                    java.net.URL u = new java.net.URL(url);
                    java.net.HttpURLConnection c = (java.net.HttpURLConnection) u.openConnection();
                    c.setConnectTimeout(10000);
                    c.setReadTimeout(20000);
                    if (referer != null && !referer.isEmpty()) c.setRequestProperty("Referer", referer);
                    c.setRequestProperty("User-Agent", "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 Chrome/120 Mobile Safari/604.1");
                    c.setRequestProperty("Accept", "*/*");
                    java.io.BufferedReader r = new java.io.BufferedReader(
                            new java.io.InputStreamReader(c.getInputStream(), "utf-8"));
                    StringBuilder b = new StringBuilder();
                    String l;
                    while ((l = r.readLine()) != null) { b.append(l); b.append('\n'); }
                    return b.toString();
                } catch (Throwable t) {
                    return "";
                }
            }
        }, "YSTV");
        wv.loadUrl(INDEX_URL);
        setContentView(wv);
    }

    @Override
    protected void onDestroy() {
        if (wv != null) {
            ((ViewGroup) wv.getParent()).removeView(wv);
            wv.destroy();
            wv = null;
        }
        super.onDestroy();
    }

    @Override
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
                    java.util.regex.Matcher m = java.util.regex.Pattern.compile("bytes=(\\d*)-").matcher(line);
                    if (m.find() && !m.group(1).isEmpty()) start = Long.parseLong(m.group(1));
                }
                line = in.readLine();
            }
            java.io.OutputStream out = new java.io.BufferedOutputStream(sk.getOutputStream());
            if (pickedUri == null) { out.write("HTTP/1.1 404 Not Found\r\n\r\n".getBytes()); out.flush(); sk.close(); return; }
            long total = querySize(pickedUri);
            java.io.InputStream is = getContentResolver().openInputStream(pickedUri);
            if (start > 0) is.skip(start);
            boolean partial = start > 0;
            out.write(("HTTP/1.1 " + (partial ? "206 Partial Content" : "200 OK") + "\r\n" +
                    "Content-Type: video/mp4\r\n" +
                    "Content-Length: " + (total - start) + "\r\n" +
                    (partial ? "Content-Range: bytes " + start + "-" + (total - 1) + "/" + total + "\r\n" : "") +
                    "Accept-Ranges: bytes\r\n\r\n").getBytes());
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
            try { sk.close(); } catch (Exception ignored) {}
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

    /* 返回键:先交给网页处理(收键盘/关播放器/关弹窗/回首页),网页说没处理才退出。
     * 单页应用没有浏览历史,以前直接 goBack() 会变成一按返回就退出应用。 */
    @Override
    public void onBackPressed() {
        if (wv == null) { super.onBackPressed(); return; }
        try {
            wv.evaluateJavascript(
                "(function(){try{return window.__onBack?window.__onBack():0}catch(e){return 0}})()",
                new android.webkit.ValueCallback<String>() {
                    public void onReceiveValue(String v) {
                        boolean handled = v != null && v.indexOf('1') >= 0;
                        if (handled) return;
                        try {
                            if (wv != null && wv.canGoBack()) wv.goBack();
                            else MainActivity.super.onBackPressed();
                        } catch (Throwable t) {
                            MainActivity.super.onBackPressed();
                        }
                    }
                });
        } catch (Throwable t) {
            super.onBackPressed();
        }
    }

    /* 渲染进程崩溃后重建 WebView 并恢复页面 */
    private void rebuild() {
        runOnUiThread(() -> {
            try {
                if (wv != null) {
                    ((ViewGroup) wv.getParent()).removeView(wv);
                    wv.destroy();
                }
                onCreate(null);
            } catch (Throwable t) {
                android.util.Log.e("TVDBG", "rebuild failed: " + t);
            }
        });
    }

    /* 暂停时停掉网页媒体,省电 */
    @Override
    protected void onPause() {
        if (wv != null) wv.onPause();
        super.onPause();
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (wv != null) wv.onResume();
    }
}
