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
    /* 语音识别(WebView 无 Web Speech API,只能走原生) */
    private android.speech.SpeechRecognizer sr = null;
    /* 语言按顺序回退:盒子/手机装的识别服务支持的未必是 zh-CN,有的只认 zh 或 cmn-Hans-CN。
     * 末尾 "" = 用系统默认语言。只试一轮,避免死循环。 */
    private static final String[] VOICE_LANGS = { "zh-CN", "zh", "cmn-Hans-CN", "" };
    private int voiceLangIdx = 0;
    private int voiceRetried = 0;   /* ERROR_CLIENT(识别器实例失效)重建重试次数 */
    private boolean voiceExt = false; /* 本次是否走的是「外部识别界面」回退通路 */

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        MiniServer.start(this);   // 局域网遥控/推送/云盘中转(0.0.0.0:9978)
        SysCtl.setActivity(this); // WiFi/蓝牙:运行时权限与系统弹窗需要 Activity

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
        // DevTools 远程调试(测试/排障用;仅影响调试桥,不改变应用行为)
        try { WebView.setWebContentsDebuggingEnabled(true); } catch (Throwable ignored) {}
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
            public String fetchText(String url, String referer) {                try {
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

            /* 语音识别:结果异步回调 window.__onVoice,不占返回值 */
            @android.webkit.JavascriptInterface
            public void startVoice() { MainActivity.this.startVoice(); }

            @android.webkit.JavascriptInterface
            public void stopVoice() { MainActivity.this.stopVoice(); }

            /* 语音能力体检:真机上「说不出字」时先看这个,能直接区分是没服务、没权限还是没麦克风 */
            @android.webkit.JavascriptInterface
            public String voiceInfo() { return MainActivity.this.voiceInfo(); }
        }, "YSTV");
        wv.loadUrl(INDEX_URL);
        setContentView(wv);
    }

    @Override
    protected void onDestroy() {
        try { if (sr != null) { sr.cancel(); sr.destroy(); sr = null; } } catch (Throwable t) {}
        if (wv != null) {
            ((ViewGroup) wv.getParent()).removeView(wv);
            wv.destroy();
            wv = null;
        }
        super.onDestroy();
    }

    @Override
    protected void onActivityResult(int req, int res, android.content.Intent data) {
        /* 外部识别界面回退通路(厂商语音 App):把它识别出的文字收回来 */
        if (req == 9003) {
            voiceExt = false;
            if (res == android.app.Activity.RESULT_OK && data != null) {
                java.util.ArrayList<String> list =
                        data.getStringArrayListExtra(android.speech.RecognizerIntent.EXTRA_RESULTS);
                String t = (list != null && !list.isEmpty()) ? list.get(0) : null;
                if (t != null && !t.isEmpty()) { voiceEvent("partial", t, null); voiceEvent("result", t, null); }
                else voiceEvent("error", null, "没听清,再说一次");
            } else {
                voiceEvent("error", null, "已取消语音输入");
            }
            return;
        }
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

    /* WiFi/蓝牙运行时权限结果 → 通知网页(页面据此自动重试扫描,不必干等轮询) */
    @Override
    public void onRequestPermissionsResult(int req, String[] perms, int[] res) {
        super.onRequestPermissionsResult(req, perms, res);
        /* 录音权限:授予后立刻开始识别,不授予就明确告诉网页 */
        if (req == 9002) {
            boolean granted = res.length > 0 && res[0] == android.content.pm.PackageManager.PERMISSION_GRANTED;
            /* 授权后回统一入口重新判断:直接 doStartVoice 会绕过「服务可用性/外部语音 App」两条回退 */
            if (granted) startVoice();
            else voiceEvent("error", null, "需要麦克风权限才能语音");
            return;
        }
        if (req != 9001) return;
        int ok = 0;
        for (int r : res) if (r == android.content.pm.PackageManager.PERMISSION_GRANTED) ok++;
        if (wv != null) {
            try {
                wv.evaluateJavascript("window.__onPerm && window.__onPerm(" + ok + "," + res.length + ")", null);
            } catch (Throwable ignored) {}
        }
    }

    /* ==================== 语音识别 ====================
     * 结果通过 window.__onVoice({type,text,msg}) 回传网页,type 为 ready/partial/result/error。
     * 设备无识别服务(多数电视盒子、模拟器)时立即回 error,网页自动降级为键盘输入。
     */
    private void voiceEvent(String type, String text, String msg) {
        if (wv == null) return;
        try {
            org.json.JSONObject o = new org.json.JSONObject();
            o.put("type", type);
            if (text != null) o.put("text", text);
            if (msg != null) o.put("msg", msg);
            final String js = "window.__onVoice&&window.__onVoice(" + org.json.JSONObject.quote(o.toString()) + ")";
            wv.post(new Runnable() {
                public void run() {
                    try { if (wv != null) wv.evaluateJavascript(js, null); } catch (Throwable t) {}
                }
            });
        } catch (Throwable t) {}
    }

    private void startVoice() {
        runOnUiThread(new Runnable() {
            public void run() {
                try {
                    if (checkSelfPermission(android.Manifest.permission.RECORD_AUDIO)
                            != android.content.pm.PackageManager.PERMISSION_GRANTED) {
                        requestPermissions(new String[]{android.Manifest.permission.RECORD_AUDIO}, 9002);
                        return;
                    }
                    voiceLangIdx = 0;
                    voiceRetried = 0;
                    /* 通路 1:标准 RecognitionService(应用内识别,不弹界面) */
                    if (android.speech.SpeechRecognizer.isRecognitionAvailable(MainActivity.this)) {
                        doStartVoice();
                        return;
                    }
                    /* 通路 2:设备没注册 RecognitionService,但可能装了厂商语音 App。
                     * 这类盒子(不少国产 TV 盒子)能用 ACTION_RECOGNIZE_SPEECH 拉起界面拿到文字。 */
                    android.content.Intent ext = buildVoiceIntent();
                    ext.putExtra(android.speech.RecognizerIntent.EXTRA_PROMPT, "请说出片名或指令");
                    if (ext.resolveActivity(getPackageManager()) != null) {
                        voiceExt = true;
                        voiceEvent("ready", null, null);
                        startActivityForResult(ext, 9003);
                        return;
                    }
                    /* 通路 3:都没有 → 明确告知,网页自动转到键盘输入 */
                    voiceEvent("error", null,
                            "此设备没有语音识别服务(未装 RecognitionService,也没有语音 App)");
                } catch (Throwable t) {
                    voiceEvent("error", null, "语音启动失败:" + t.getMessage());
                }
            }
        });
    }

    /* 识别请求:中文优先。盒子上常驻语言常是英文,不指定会把中文识别成乱码 */
    private android.content.Intent buildVoiceIntent() {
        android.content.Intent i = new android.content.Intent(android.speech.RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
        i.putExtra(android.speech.RecognizerIntent.EXTRA_LANGUAGE_MODEL,
                android.speech.RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
        String lang = VOICE_LANGS[Math.min(voiceLangIdx, VOICE_LANGS.length - 1)];
        if (!lang.isEmpty()) {
            i.putExtra(android.speech.RecognizerIntent.EXTRA_LANGUAGE, lang);
            i.putExtra(android.speech.RecognizerIntent.EXTRA_LANGUAGE_PREFERENCE, lang);
        }
        i.putExtra(android.speech.RecognizerIntent.EXTRA_PARTIAL_RESULTS, true);
        i.putExtra(android.speech.RecognizerIntent.EXTRA_MAX_RESULTS, 3);
        return i;
    }

    private void doStartVoice() {
        try {
            if (sr == null) {
                sr = android.speech.SpeechRecognizer.createSpeechRecognizer(this);
                sr.setRecognitionListener(new VoiceListener());
            }
            sr.startListening(buildVoiceIntent());
        } catch (Throwable t) {
            voiceEvent("error", null, "语音启动失败:" + t.getMessage());
        }
    }

    /* 识别器实例只在 ERROR_CLIENT(如被系统回收/服务重启)后销毁,下次重新创建。
     * 直接复用失效实例会让 startListening 静默不回调,表现就是「点了没反应」。 */
    private void resetRecognizer() {
        try { if (sr != null) { sr.cancel(); sr.destroy(); } } catch (Throwable t) {}
        sr = null;
    }

    /* 语音能力体检:返回 JSON 字符串,网页「诊断」按钮和 tools/voice-check.js 都读它 */
    private String voiceInfo() {
        try {
            org.json.JSONObject o = new org.json.JSONObject();
            o.put("api", android.os.Build.VERSION.SDK_INT);
            o.put("model", android.os.Build.MODEL == null ? "" : android.os.Build.MODEL);
            o.put("hasRec", android.speech.SpeechRecognizer.isRecognitionAvailable(this));
            o.put("hasMic", getPackageManager().hasSystemFeature(
                    android.content.pm.PackageManager.FEATURE_MICROPHONE));
            o.put("perm", checkSelfPermission(android.Manifest.permission.RECORD_AUDIO)
                    == android.content.pm.PackageManager.PERMISSION_GRANTED);
            o.put("hasExtApp", buildVoiceIntent().resolveActivity(getPackageManager()) != null);
            /* 通路 1 是首次尝试过的语言(实际生效的由识别器决定) */
            o.put("lang", VOICE_LANGS[0]);
            /* 已安装的识别服务包名:为空就是「设备真的没有识别服务」 */
            org.json.JSONArray arr = new org.json.JSONArray();
            try {
                java.util.List<android.content.pm.ResolveInfo> rs = getPackageManager().queryIntentServices(
                        new android.content.Intent("android.speech.RecognitionService"), 0);
                for (android.content.pm.ResolveInfo ri : rs) {
                    if (ri.serviceInfo != null) arr.put(ri.serviceInfo.packageName);
                }
            } catch (Throwable ignored) {}
            o.put("services", arr);
            return o.toString();
        } catch (Throwable t) {
            return "{\"err\":\"" + t.getMessage() + "\"}";
        }
    }

    /* 遥控器唤出语音:VOICE_ASSIST(231) / 搜索键(84) / 长按 MENU(82)。
     * 231 在部分 ROM 被系统助手先接管(收不到),所以另给两个不冲突的入口。 */
    private long menuDownAt = 0;

    private void openVoicePanel() {
        if (wv == null) return;
        try {
            wv.evaluateJavascript(
                    "(function(){if(window.Voice){Voice.isOpen()?Voice.retry():Voice.start();}})()", null);
        } catch (Throwable ignored) {}
    }

    @Override
    public boolean dispatchKeyEvent(android.view.KeyEvent e) {
        int k = e.getKeyCode();
        if (k == 231 /* KEYCODE_VOICE_ASSIST */ || k == android.view.KeyEvent.KEYCODE_SEARCH) {
            if (e.getAction() == android.view.KeyEvent.ACTION_DOWN) { openVoicePanel(); return true; }
            if (e.getAction() == android.view.KeyEvent.ACTION_UP) return true;
        }
        if (k == android.view.KeyEvent.KEYCODE_MENU) {
            /* 长按信号有两种来源:注入/系统会在 ACTION_DOWN 上补一个 repeatCount>=1
             * (isLongPress=true)的事件;真机也可能只在 UP 时靠时长判断。两者都接。 */
            if (e.getAction() == android.view.KeyEvent.ACTION_DOWN) {
                if (menuDownAt == 0) menuDownAt = System.currentTimeMillis();
                if (e.isLongPress() || e.getRepeatCount() > 0
                        || System.currentTimeMillis() - menuDownAt > 550) {
                    menuDownAt = 0;
                    openVoicePanel();
                    return true;
                }
                return false;
            }
            if (e.getAction() == android.view.KeyEvent.ACTION_UP) {
                boolean lp = menuDownAt != 0 && System.currentTimeMillis() - menuDownAt > 550;
                menuDownAt = 0;
                if (lp) { openVoicePanel(); return true; }
                return false;
            }
            return false;
        }
        return super.dispatchKeyEvent(e);
    }

    private void stopVoice() {
        runOnUiThread(new Runnable() {
            public void run() {
                try { if (sr != null) sr.cancel(); } catch (Throwable t) {}
            }
        });
    }

    private String voiceErrText(int code) {
        switch (code) {
            case android.speech.SpeechRecognizer.ERROR_NO_MATCH: return "没听清,再说一次";
            case android.speech.SpeechRecognizer.ERROR_SPEECH_TIMEOUT: return "没有听到声音";
            case android.speech.SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS: return "没有录音权限";
            case android.speech.SpeechRecognizer.ERROR_NETWORK:
            case android.speech.SpeechRecognizer.ERROR_NETWORK_TIMEOUT:
            case android.speech.SpeechRecognizer.ERROR_SERVER: return "识别服务连不上(部分设备需联网)";
            case android.speech.SpeechRecognizer.ERROR_RECOGNIZER_BUSY: return "识别器忙,稍后再试";
            case android.speech.SpeechRecognizer.ERROR_AUDIO: return "麦克风不可用";
            case 10: return "识别请求太频繁,歇一下再说";     /* ERROR_TOO_MANY_REQUESTS */
            case 11: return "识别服务断开了,重试一次";       /* ERROR_SERVER_DISCONNECTED */
            case 12: return "识别服务不支持中文";            /* ERROR_LANGUAGE_NOT_SUPPORTED */
            case 13: return "识别服务缺中文语言包";          /* ERROR_LANGUAGE_UNAVAILABLE */
            case 14: return "识别服务不可用(状态异常)";      /* ERROR_CANNOT_CHECK_SUPPORT */
            default: return "识别失败(" + code + ")";
        }
    }

    private class VoiceListener implements android.speech.RecognitionListener {
        public void onReadyForSpeech(Bundle p) { voiceRetried = 0; voiceEvent("ready", null, null); }
        public void onBeginningOfSpeech() {}
        public void onRmsChanged(float v) {}
        public void onBufferReceived(byte[] b) {}
        public void onEndOfSpeech() {}
        public void onError(int code) {
            /* 语言不被支持(12/13):换一种写法再试,不打扰用户。
             * 盒子上的识别服务常只认 zh 或 cmn-Hans-CN,写死 zh-CN 会直接失败。 */
            if ((code == 12 || code == 13) && voiceLangIdx < VOICE_LANGS.length - 1) {
                voiceLangIdx++;
                if (wv != null) wv.postDelayed(new Runnable() {
                    public void run() { try { doStartVoice(); } catch (Throwable t) {} }
                }, 150);
                return;
            }
            /* ERROR_CLIENT(5):识别器实例被系统回收/服务重启,重建后重试一次。
             * 不重建的话表现为「点了没反应」(startListening 不回调)。 */
            if (code == android.speech.SpeechRecognizer.ERROR_CLIENT && voiceRetried < 1) {
                voiceRetried++;
                resetRecognizer();
                if (wv != null) wv.postDelayed(new Runnable() {
                    public void run() { try { doStartVoice(); } catch (Throwable t) {} }
                }, 260);
                return;
            }
            resetRecognizer();   /* 其它错误:释放实例,下次 startVoice 重新创建 */
            voiceEvent("error", null, voiceErrText(code));
        }
        public void onResults(Bundle b) {
            java.util.ArrayList<String> list = (b == null) ? null
                    : b.getStringArrayList(android.speech.SpeechRecognizer.RESULTS_RECOGNITION);
            voiceEvent("result", (list != null && !list.isEmpty()) ? list.get(0) : "", null);
        }
        public void onPartialResults(Bundle b) {
            java.util.ArrayList<String> list = (b == null) ? null
                    : b.getStringArrayList(android.speech.SpeechRecognizer.RESULTS_RECOGNITION);
            if (list != null && !list.isEmpty()) voiceEvent("partial", list.get(0), null);
        }
        public void onEvent(int t, Bundle b) {}
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
