package tv.yingshi.app;

import android.content.Context;
import android.content.pm.PackageManager;
import android.media.AudioFormat;
import android.media.AudioRecord;
import android.media.MediaRecorder;
import android.os.Build;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;

/**
 * 通用录音:自己从麦克风取样,不依赖任何系统识别服务。
 *
 * 为什么需要:
 *   android.speech.SpeechRecognizer 要求设备装了 RecognitionService(GMS / 厂商语音)。
 *   国产电视盒子绝大多数没有 —— 实测 hasRec=false、services=[],
 *   此时「有没有麦克风」已经不重要,因为根本没有东西把声音变成文字。
 *   唯一能通吃的办法:自己录音 → 交给云端 ASR。
 *
 * 格式:16kHz / 16bit / 单声道 WAV —— Whisper、阿里、腾讯、讯飞全都直接吃。
 *
 * 自带 VAD:说完静音 TAIL_MS 自动收尾(电视用遥控器,没人愿意再按一次「停止」);
 *          全程无信号则提前退出并标记 silent,方便前端区分「没麦克风」和「没识别服务」。
 */
public class VoiceRec {

    public static final int RATE = 16000;
    private static final int MAX_MS = 10000;      // 最长一段
    private static final int TAIL_MS = 900;       // 静音多久算说完
    private static final int GRACE_MS = 1600;     // 开录后宽限,别把「还没开口」判成「说完了」
    private static final int AMP_TH = 500;        // 有声音的振幅阈值(16bit)
    private static final int NO_SIGNAL_MS = 2400; // 这么久一点信号都没有 → 判定没有可用麦克风
    private static final String NAME = "voice.wav";

    private static AudioRecord ar;
    private static Thread th;
    private static volatile boolean running = false;
    private static volatile boolean stopping = false;
    private static volatile int ms = 0;
    private static volatile int peak = 0;
    private static volatile int voiced = 0;       // 有声音的毫秒数
    private static volatile String err = null;
    private static ByteArrayOutputStream buf;
    private static Cb cb;

    /** 录音结束回调(在主线程) */
    public interface Cb { void onDone(JSONObject r); }

    public static void setCb(Cb c) { cb = c; }

    public static boolean hasPerm(Context c) {
        return c.checkSelfPermission(android.Manifest.permission.RECORD_AUDIO)
                == PackageManager.PERMISSION_GRANTED;
    }

    public static File wavFile(Context c) {
        return new File(c.getCacheDir(), NAME);
    }

    public static boolean isRunning() { return running; }

    /* ---------------- 开始 ---------------- */

    public static synchronized JSONObject start(final Context c) {
        JSONObject o = new JSONObject();
        try {
            if (!hasPerm(c)) {
                o.put("ok", false); o.put("err", "noperm"); o.put("msg", "没有录音权限");
                return o;
            }
            if (running) { o.put("ok", true); o.put("msg", "已在录音"); return o; }
            if (!c.getPackageManager().hasSystemFeature(PackageManager.FEATURE_MICROPHONE)) {
                o.put("ok", false); o.put("err", "nomic");
                o.put("msg", "此设备没有麦克风(系统未声明 FEATURE_MICROPHONE)");
                return o;
            }
            /* 清掉上一段,避免把旧音频当成本次结果 */
            File f = wavFile(c);
            if (f.exists()) f.delete();

            ms = 0; peak = 0; voiced = 0; err = null; stopping = false;
            final int minBuf = AudioRecord.getMinBufferSize(
                    RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT);
            final int bufSize = Math.max(minBuf > 0 ? minBuf * 2 : 0, RATE); // 至少 0.5s

            ar = create(bufSize);
            if (ar == null || ar.getState() != AudioRecord.STATE_INITIALIZED) {
                releaseQuiet();
                o.put("ok", false); o.put("err", "openfail");
                o.put("msg", "麦克风打不开(被其它应用占用,或设备无输入通道)");
                return o;
            }

            running = true;
            th = new Thread(new Runnable() {
                public void run() { loop(c, f(c)); }
            }, "voice-rec");
            th.start();

            o.put("ok", true);
            o.put("rate", RATE);
            o.put("msg", "开始录音");
            return o;
        } catch (Throwable t) {
            running = false; releaseQuiet();
            try { o.put("ok", false); o.put("err", "exc"); o.put("msg", "录音启动失败:" + t); } catch (Throwable ignored) {}
            return o;
        }
    }

    private static File f(Context c) { return wavFile(c); }

    /** VOICE_RECOGNITION 关掉系统降噪/AGC,拿到的是干净人声,更适合喂 ASR;不支持时退回 MIC */
    private static AudioRecord create(int bufSize) {
        int[] sources = new int[] {
                MediaRecorder.AudioSource.VOICE_RECOGNITION,
                MediaRecorder.AudioSource.MIC
        };
        for (int src : sources) {
            AudioRecord r = null;
            try {
                if (Build.VERSION.SDK_INT >= 23) {
                    r = new AudioRecord.Builder()
                            .setAudioSource(src)
                            .setAudioFormat(new AudioFormat.Builder()
                                    .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                                    .setSampleRate(RATE)
                                    .setChannelMask(AudioFormat.CHANNEL_IN_MONO)
                                    .build())
                            .setBufferSizeInBytes(bufSize)
                            .build();
                } else {
                    r = new AudioRecord(src, RATE, AudioFormat.CHANNEL_IN_MONO,
                            AudioFormat.ENCODING_PCM_16BIT, bufSize);
                }
                if (r.getState() == AudioRecord.STATE_INITIALIZED) return r;
                try { r.release(); } catch (Throwable ignored) {}
            } catch (Throwable t) {
                try { if (r != null) r.release(); } catch (Throwable ignored) {}
            }
        }
        return null;
    }

    private static void releaseQuiet() {
        try { if (ar != null) { ar.stop(); } } catch (Throwable ignored) {}
        try { if (ar != null) { ar.release(); } } catch (Throwable ignored) {}
        ar = null;
    }

    /* ---------------- 录音线程 ---------------- */

    private static void loop(Context c, File out) {
        byte[] b = new byte[3200]; // 100ms @16k/16bit
        buf = new ByteArrayOutputStream(RATE * 2 * 6);
        AudioRecord rec = ar;
        try {
            rec.startRecording();
            long t0 = System.currentTimeMillis();
            int lastVoiced = 0;
            while (!stopping) {
                int n = rec.read(b, 0, b.length);
                if (n <= 0) break;
                buf.write(b, 0, n);

                int m = 0;
                for (int i = 0; i + 1 < n; i += 2) {
                    int v = (short) ((b[i] & 0xFF) | ((b[i + 1] & 0xFF) << 8));
                    int a = v < 0 ? -v : v;
                    if (a > m) m = a;
                }
                if (m > peak) peak = m;

                int e = (int) (System.currentTimeMillis() - t0);
                ms = e;
                if (m > AMP_TH) { lastVoiced = e; voiced += n / 32; }

                /* GRACE:点完按钮往往要愣一下才开口,前 1.6s 不判静音收尾,
                   否则用户还没说话就被「说完」了 */
                if (e > GRACE_MS && e - lastVoiced > TAIL_MS) break;   // 说完了
                if (e > MAX_MS) break;                                 // 到顶
                if (peak < 120 && e > NO_SIGNAL_MS) break;              // 完全没有输入信号
            }
        } catch (Throwable t) {
            err = String.valueOf(t.getMessage());
        } finally {
            releaseQuiet();
        }

        /* 落盘为 WAV(带 44 字节头),失败也不影响回调里的诊断信息 */
        int bytes = 0;
        try {
            byte[] pcm = buf == null ? new byte[0] : buf.toByteArray();
            bytes = pcm.length;
            if (pcm.length > 0) writeWav(out, pcm);
        } catch (Throwable t) {
            if (err == null) err = "写文件失败:" + t.getMessage();
        }
        buf = null;
        running = false;

        JSONObject o = new JSONObject();
        try {
            o.put("ok", err == null && bytes > 0);
            o.put("ms", ms);
            o.put("bytes", bytes);
            o.put("peak", peak);
            o.put("voiced", voiced);
            o.put("silent", peak < 120);
            o.put("rate", RATE);
            o.put("file", out.getAbsolutePath());
            if (err != null) o.put("err", err);
            if (bytes == 0) o.put("msg", "没有录到音频");
        } catch (Throwable ignored) {}

        Cb c0 = cb;
        if (c0 != null) c0.onDone(o);
    }

    /* ---------------- 停止 ---------------- */

    public static synchronized JSONObject stop() {
        JSONObject o = new JSONObject();
        try {
            if (!running) {
                o.put("ok", false); o.put("err", "idle"); o.put("msg", "当前没有在录音");
                return o;
            }
            stopping = true;                 // 让 read 循环下一轮退出
            o.put("ok", true);
            o.put("msg", "正在收尾");
            return o;
        } catch (Throwable t) {
            try { o.put("ok", false); o.put("msg", String.valueOf(t)); } catch (Throwable ignored) {}
            return o;
        }
    }

    /** 供 /voice/state 用:网页轮询兜底(回调丢了也不会卡死) */
    public static JSONObject state() {
        JSONObject o = new JSONObject();
        try {
            o.put("rec", running);
            o.put("ms", ms);
            o.put("peak", peak);
            o.put("rate", RATE);
        } catch (Throwable ignored) {}
        return o;
    }

    /* ---------------- WAV ---------------- */

    private static void writeWav(File out, byte[] pcm) throws Exception {
        File dir = out.getParentFile();
        if (dir != null && !dir.exists()) dir.mkdirs();
        FileOutputStream fos = new FileOutputStream(out);
        try {
            int ch = 1, bits = 16;
            int dataLen = pcm.length;
            int byteRate = RATE * ch * bits / 8;
            byte[] h = new byte[44];
            h[0] = 'R'; h[1] = 'I'; h[2] = 'F'; h[3] = 'F';
            putInt(h, 4, 36 + dataLen);
            h[8] = 'W'; h[9] = 'A'; h[10] = 'V'; h[11] = 'E';
            h[12] = 'f'; h[13] = 'm'; h[14] = 't'; h[15] = ' ';
            putInt(h, 16, 16);              // fmt 块长度
            putShort(h, 20, 1);             // PCM
            putShort(h, 22, ch);
            putInt(h, 24, RATE);
            putInt(h, 28, byteRate);
            putShort(h, 32, ch * bits / 8); // blockAlign
            putShort(h, 34, bits);
            h[36] = 'd'; h[37] = 'a'; h[38] = 't'; h[39] = 'a';
            putInt(h, 40, dataLen);
            fos.write(h);
            fos.write(pcm);
            fos.flush();
        } finally {
            try { fos.close(); } catch (Throwable ignored) {}
        }
    }

    private static void putInt(byte[] b, int off, int v) {
        b[off] = (byte) (v & 0xFF);
        b[off + 1] = (byte) ((v >> 8) & 0xFF);
        b[off + 2] = (byte) ((v >> 16) & 0xFF);
        b[off + 3] = (byte) ((v >> 24) & 0xFF);
    }

    private static void putShort(byte[] b, int off, int v) {
        b[off] = (byte) (v & 0xFF);
        b[off + 1] = (byte) ((v >> 8) & 0xFF);
    }
}
