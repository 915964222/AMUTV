package tv.yingshi.app;

import android.Manifest;
import android.app.Activity;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothDevice;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.PackageManager;
import android.net.wifi.ScanResult;
import android.net.wifi.WifiConfiguration;
import android.net.wifi.WifiInfo;
import android.net.wifi.WifiManager;
import android.net.wifi.WifiNetworkSuggestion;
import android.os.Build;
import android.provider.Settings;

import org.json.JSONArray;
import org.json.JSONObject;

import java.lang.ref.WeakReference;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.HashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/* ============================================================
 * 系统能力:WiFi / 蓝牙(供网页设置页调用,经 MiniServer 的 /sys/* 端点)
 *
 * 平台限制(如实返回,不假装成功):
 *  · Android 10(Q) 起普通应用**不能**程序化开关 WiFi,只能跳系统设置页;
 *  · 蓝牙开关可用 ACTION_REQUEST_ENABLE 弹系统确认框(用户点允许);
 *  · WiFi 扫描需要定位权限(且系统定位总开关要开),13+ 还建议 NEARBY_WIFI_DEVICES;
 *  · WiFi 连接:30+ 走系统「添加网络」弹窗(WIFI_ADD_NETWORKS,体验最好),
 *    29 走 WifiNetworkSuggestion,28- 走 addNetwork;
 *  · 蓝牙扫描/配对需要 BLUETOOTH_SCAN / BLUETOOTH_CONNECT(12+);
 *  · 模拟器/盒子常无蓝牙硬件 → supported=false,前端据此显示"本机无蓝牙"。
 * ============================================================ */
public class SysCtl {

    private static WeakReference<Activity> actRef = null;

    public static void setActivity(Activity a) { actRef = new WeakReference<Activity>(a); }

    private static Activity act() { return actRef == null ? null : actRef.get(); }

    /* ---------------- 权限 ---------------- */

    private static boolean has(Context c, String p) {
        try { return c.checkSelfPermission(p) == PackageManager.PERMISSION_GRANTED; }
        catch (Throwable t) { return false; }
    }

    /* WiFi 扫描/连接需要的权限(按 SDK 分层,避免低版本申请不存在的权限) */
    private static List<String> wifiPerms() {
        List<String> l = new ArrayList<String>();
        if (Build.VERSION.SDK_INT >= 33) l.add("android.permission.NEARBY_WIFI_DEVICES");
        l.add(Manifest.permission.ACCESS_FINE_LOCATION);
        l.add(Manifest.permission.ACCESS_COARSE_LOCATION);
        return l;
    }

    private static List<String> btPerms() {
        List<String> l = new ArrayList<String>();
        if (Build.VERSION.SDK_INT >= 31) {
            l.add("android.permission.BLUETOOTH_SCAN");
            l.add("android.permission.BLUETOOTH_CONNECT");
        } else {
            l.add(Manifest.permission.ACCESS_FINE_LOCATION); // 老系统扫描蓝牙也要定位
        }
        return l;
    }

    public static List<String> missingWiFi(Context c) {
        List<String> out = new ArrayList<String>();
        for (String p : wifiPerms()) if (!has(c, p)) out.add(p);
        return out;
    }

    public static List<String> missingBt(Context c) {
        List<String> out = new ArrayList<String>();
        for (String p : btPerms()) if (!has(c, p)) out.add(p);
        return out;
    }

    /* 缺权限就在 UI 线程弹系统授权框;返回是否已经全部具备 */
    public static boolean ensurePerms(Context c, boolean wifi, boolean bt) {
        final Set<String> need = new LinkedHashSet<String>();
        if (wifi) need.addAll(missingWiFi(c));
        if (bt) need.addAll(missingBt(c));
        if (need.isEmpty()) return true;
        final Activity a = act();
        if (a == null) return false;
        a.runOnUiThread(new Runnable() {
            public void run() {
                try { a.requestPermissions(need.toArray(new String[0]), 9001); } catch (Throwable t) {}
            }
        });
        return false;
    }

    private static JSONArray permArray(List<String> l) {
        JSONArray a = new JSONArray();
        for (String s : l) a.put(s.replace("android.permission.", ""));
        return a;
    }

    /* ---------------- WiFi ---------------- */

    private static WifiManager wifi(Context c) {
        try { return (WifiManager) c.getApplicationContext().getSystemService(Context.WIFI_SERVICE); }
        catch (Throwable t) { return null; }
    }

    private static String cleanSsid(String s) {
        if (s == null) return "";
        s = s.replace("\"", "").trim();
        if (s.equalsIgnoreCase("<unknown ssid>") || s.equalsIgnoreCase("0x") || s.equalsIgnoreCase("unknown")) return "";
        return s;
    }

    private static String ipStr(int ip) {
        if (ip == 0) return "";
        return ((ip & 0xff)) + "." + ((ip >> 8) & 0xff) + "." + ((ip >> 16) & 0xff) + "." + ((ip >> 24) & 0xff);
    }

    public static JSONObject wifiState(Context c) {
        JSONObject o = new JSONObject();
        try {
            WifiManager wm = wifi(c);
            if (wm == null) { o.put("supported", false); return o; }
            o.put("supported", true);
            o.put("enabled", wm.isWifiEnabled());
            WifiInfo wi = null;
            try { wi = wm.getConnectionInfo(); } catch (Throwable ignored) {}
            String ssid = wi != null ? cleanSsid(wi.getSSID()) : "";
            o.put("ssid", ssid);
            o.put("connected", ssid.length() > 0);
            o.put("ip", wi != null ? ipStr(wi.getIpAddress()) : "");
            o.put("rssi", wi != null ? wi.getRssi() : 0);
            o.put("needPerm", missingWiFi(c).size() > 0);
        } catch (Throwable t) {
            try { o.put("supported", false); } catch (Throwable ignored) {}
        }
        return o;
    }

    private static boolean secured(ScanResult r) {
        String cap = r.capabilities == null ? "" : r.capabilities;
        return cap.contains("WEP") || cap.contains("PSK") || cap.contains("WPA") || cap.contains("EAP") || cap.contains("SAE");
    }

    /* 扫描:先用缓存结果(getScanResults),空则 startScan 后最多等 ~5s。
       Android 9+ 对 startScan 有频率限制(2 分钟窗口),所以缓存优先很重要。 */
    public static JSONObject wifiScan(Context c) {
        JSONObject out = new JSONObject();
        try {
            WifiManager wm = wifi(c);
            if (wm == null) { out.put("ok", false); out.put("msg", "本机不支持 WiFi"); return out; }
            if (!wm.isWifiEnabled()) {
                out.put("ok", false); out.put("off", true);
                out.put("msg", "WiFi 已关闭,请先在系统设置里打开");
                return out;
            }
            List<String> miss = missingWiFi(c);
            if (!miss.isEmpty()) {
                ensurePerms(c, true, false);
                out.put("ok", false); out.put("needPerm", true);
                out.put("missing", permArray(miss));
                out.put("msg", "需要「定位/附近设备」权限才能扫描 WiFi");
                return out;
            }
            List<ScanResult> rs = null;
            try { rs = wm.getScanResults(); } catch (Throwable ignored) {}
            if (rs == null || rs.isEmpty()) {
                try { wm.startScan(); } catch (Throwable ignored) {}
                for (int i = 0; i < 12; i++) {
                    Thread.sleep(450);
                    try { rs = wm.getScanResults(); } catch (Throwable ignored) {}
                    if (rs != null && !rs.isEmpty()) break;
                }
            }
            String cur = "";
            try {
                WifiInfo wi = wm.getConnectionInfo();
                cur = wi != null ? cleanSsid(wi.getSSID()) : "";
            } catch (Throwable ignored) {}

            /* 同一 SSID 多个 AP(同网关多频)合并,保留最强信号 */
            Map<String, ScanResult> best = new HashMap<String, ScanResult>();
            if (rs != null) {
                for (ScanResult r : rs) {
                    String s = cleanSsid(r.SSID);
                    if (s.isEmpty()) continue;
                    ScanResult old = best.get(s);
                    if (old == null || r.level > old.level) best.put(s, r);
                }
            }
            final String current = cur;
            List<ScanResult> list = new ArrayList<ScanResult>(best.values());
            Collections.sort(list, new Comparator<ScanResult>() {
                public int compare(ScanResult a, ScanResult b) {
                    boolean ca = cleanSsid(a.SSID).equals(current), cb = cleanSsid(b.SSID).equals(current);
                    if (ca != cb) return ca ? -1 : 1;
                    return b.level - a.level;
                }
            });
            JSONArray arr = new JSONArray();
            for (ScanResult r : list) {
                JSONObject j = new JSONObject();
                String s = cleanSsid(r.SSID);
                j.put("ssid", s);
                j.put("rssi", r.level);
                j.put("bars", WifiManager.calculateSignalLevel(r.level, 5) + 1);
                j.put("secured", secured(r));
                j.put("current", s.equals(current));
                j.put("freq", r.frequency);
                arr.put(j);
            }
            out.put("ok", true);
            out.put("list", arr);
            if (arr.length() == 0) out.put("msg", "没扫到网络(系统可能限流,请 30 秒后再试,或确认系统定位已打开)");
            else out.put("msg", "共 " + arr.length() + " 个网络");
        } catch (Throwable t) {
            try { out.put("ok", false); out.put("msg", "扫描失败:" + t); } catch (Throwable ignored) {}
        }
        return out;
    }

    /* 连接:按 SDK 走系统弹窗 / suggestion / legacy,失败信息写清楚怎么兜底 */
    public static JSONObject wifiConnect(Context c, String ssid, String pwd) {
        JSONObject out = new JSONObject();
        try {
            WifiManager wm = wifi(c);
            if (wm == null) { out.put("ok", false); out.put("msg", "本机不支持 WiFi"); return out; }
            if (ssid == null || ssid.length() == 0) { out.put("ok", false); out.put("msg", "SSID 为空"); return out; }
            boolean open = pwd == null || pwd.length() == 0;

            if (Build.VERSION.SDK_INT >= 30) {
                /* Android 11+: 系统「添加网络」对话框 —— 用户确认后系统自己完成连接与保存,最可靠 */
                final Activity a = act();
                if (a != null) {
                    ArrayList<WifiNetworkSuggestion> sugg = new ArrayList<WifiNetworkSuggestion>();
                    WifiNetworkSuggestion.Builder b = new WifiNetworkSuggestion.Builder().setSsid(ssid);
                    /* 开放网络 = 不设置任何密钥字段(WifiNetworkSuggestion 没有 setIsOpenNetwork) */
                    if (!open) b.setWpa2Passphrase(pwd);
                    sugg.add(b.build());
                    final Intent i = new Intent("android.settings.WIFI_ADD_NETWORKS");
                    i.putParcelableArrayListExtra("android.provider.extra.WIFI_NETWORK_LIST", sugg);
                    a.runOnUiThread(new Runnable() {
                        public void run() { try { a.startActivity(i); } catch (Throwable t) {} }
                    });
                    out.put("ok", true);
                    out.put("mode", "dialog");
                    out.put("msg", "已打开系统「添加网络」确认框,点『连接』即可完成");
                    return out;
                }
            }
            if (Build.VERSION.SDK_INT >= 29) {
                WifiNetworkSuggestion.Builder b = new WifiNetworkSuggestion.Builder().setSsid(ssid);
                if (!open) b.setWpa2Passphrase(pwd);
                int st = wm.addNetworkSuggestions(Collections.singletonList(b.build()));
                boolean okS = st == WifiManager.STATUS_NETWORK_SUGGESTIONS_SUCCESS;
                out.put("ok", okS);
                out.put("mode", "suggestion");
                out.put("needSettings", !okS);
                out.put("msg", okS ? "已提交系统建议,通知栏点『允许』后自动连接"
                        : ("系统拒绝提交(code=" + st + "),请用「系统设置」手动连接"));
                return out;
            }
            /* Android 9 及以下:直接建配置并连接 */
            WifiConfiguration cfg = new WifiConfiguration();
            cfg.SSID = "\"" + ssid + "\"";
            if (open) {
                cfg.allowedKeyManagement.set(WifiConfiguration.KeyMgmt.NONE);
            } else {
                cfg.preSharedKey = "\"" + pwd + "\"";
            }
            int id = wm.addNetwork(cfg);
            if (id < 0) {
                /* Android 9+ 对第三方应用加了限制(部分机型/虚拟 WiFi 直接返回 -1),
                   不再假装能连 —— 直接跳系统 WiFi 列表让用户点选,这是最可靠的兜底 */
                openWifiSettings(c);
                out.put("ok", false);
                out.put("needSettings", true);
                out.put("msg", "系统不允许应用直接添加网络,已打开系统 WiFi 列表,请点选「" + ssid + "」输入密码连接");
                return out;
            }
            wm.disconnect();
            wm.enableNetwork(id, true);
            wm.reconnect();
            out.put("ok", true);
            out.put("mode", "legacy");
            out.put("msg", "已发起连接,请稍候查看状态");
            return out;
        } catch (Throwable t) {
            try { out.put("ok", false); out.put("msg", "连接失败:" + t); } catch (Throwable ignored) {}
            return out;
        }
    }

    public static void openWifiSettings(Context c) {
        openSettings(c, Settings.ACTION_WIFI_SETTINGS);
    }

    public static void openSettings(Context c, String action) {
        final Activity a = act();
        final Context base = a != null ? (Context) a : c;
        final Intent i = new Intent(action);
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        Runnable r = new Runnable() {
            public void run() {
                try { base.startActivity(i); } catch (Throwable t) { android.util.Log.e("TVSYS", "open " + action + ": " + t); }
            }
        };
        if (a != null) a.runOnUiThread(r); else r.run();
    }

    /* ---------------- 蓝牙 ---------------- */

    private static BluetoothAdapter bt() {
        try { return BluetoothAdapter.getDefaultAdapter(); } catch (Throwable t) { return null; }
    }

    public static JSONObject btState(Context c) {
        JSONObject o = new JSONObject();
        try {
            BluetoothAdapter a = bt();
            if (a == null) { o.put("supported", false); o.put("msg", "本机没有蓝牙硬件"); return o; }
            o.put("supported", true);
            boolean en = false, granted = missingBt(c).isEmpty();
            try { en = a.isEnabled(); } catch (Throwable ignored) {}
            o.put("enabled", en);
            o.put("needPerm", !granted);
            String name = "";
            try { name = a.getName(); } catch (Throwable ignored) {}
            o.put("name", name == null ? "" : name);
            JSONArray arr = new JSONArray();
            if (en && granted) {
                try {
                    Set<BluetoothDevice> bs = a.getBondedDevices();
                    if (bs != null) for (BluetoothDevice d : bs) arr.put(devJson(d, 0, true));
                } catch (Throwable ignored) {}
            }
            o.put("bonded", arr);
        } catch (Throwable t) {
            try { o.put("supported", false); } catch (Throwable ignored) {}
        }
        return o;
    }

    private static String typeName(int type) {
        switch (type) {
            case BluetoothDevice.DEVICE_TYPE_CLASSIC: return "经典";
            case BluetoothDevice.DEVICE_TYPE_LE: return "BLE";
            case BluetoothDevice.DEVICE_TYPE_DUAL: return "双模";
            default: return "未知";
        }
    }

    private static JSONObject devJson(BluetoothDevice d, int rssi, boolean bonded) {
        JSONObject j = new JSONObject();
        try {
            String nm = "", mac = "";
            try { nm = d.getName(); } catch (Throwable ignored) {}
            try { mac = d.getAddress(); } catch (Throwable ignored) {}
            int type = 0;
            try { type = d.getType(); } catch (Throwable ignored) {}
            j.put("name", nm == null || nm.length() == 0 ? "(未命名设备)" : nm);
            j.put("mac", mac == null ? "" : mac);
            j.put("type", typeName(type));
            j.put("rssi", rssi);
            j.put("bonded", bonded || d.getBondState() == BluetoothDevice.BOND_BONDED);
        } catch (Throwable t) {}
        return j;
    }

    /* 发现结果缓存 + 广播接收(只注册一次) */
    private static final Map<String, JSONObject> found = Collections.synchronizedMap(new HashMap<String, JSONObject>());
    private static volatile boolean discovering = false;
    private static BroadcastReceiver btRcv = null;

    private static synchronized void ensureReceiver(Context c) {
        if (btRcv != null) return;
        btRcv = new BroadcastReceiver() {
            public void onReceive(Context ctx, Intent i) {
                try {
                    String act = i.getAction();
                    if (BluetoothDevice.ACTION_FOUND.equals(act)) {
                        BluetoothDevice d = i.getParcelableExtra(BluetoothDevice.EXTRA_DEVICE);
                        short rssi = i.getShortExtra(BluetoothDevice.EXTRA_RSSI, (short) 0);
                        if (d != null) {
                            String mac = "";
                            try { mac = d.getAddress(); } catch (Throwable ignored) {}
                            if (mac != null && mac.length() > 0) found.put(mac, devJson(d, rssi, false));
                        }
                    } else if (BluetoothAdapter.ACTION_DISCOVERY_FINISHED.equals(act)) {
                        discovering = false;
                    }
                } catch (Throwable t) {}
            }
        };
        IntentFilter f = new IntentFilter();
        f.addAction(BluetoothDevice.ACTION_FOUND);
        f.addAction(BluetoothAdapter.ACTION_DISCOVERY_FINISHED);
        try {
            if (Build.VERSION.SDK_INT >= 33) c.getApplicationContext().registerReceiver(btRcv, f, Context.RECEIVER_NOT_EXPORTED);
            else c.getApplicationContext().registerReceiver(btRcv, f);
        } catch (Throwable t) { btRcv = null; }
    }

    /* 扫描:阻塞等待最多 ~13s,返回已配对 + 新发现(去重) */
    public static JSONObject btScan(Context c) {
        JSONObject out = new JSONObject();
        try {
            BluetoothAdapter a = bt();
            if (a == null) { out.put("ok", false); out.put("supported", false); out.put("msg", "本机没有蓝牙硬件"); return out; }
            if (missingBt(c).size() > 0) {
                ensurePerms(c, false, true);
                out.put("ok", false); out.put("needPerm", true);
                out.put("missing", permArray(missingBt(c)));
                out.put("msg", "需要「附近的设备」权限才能扫描蓝牙");
                return out;
            }
            if (!a.isEnabled()) {
                out.put("ok", false); out.put("off", true); out.put("msg", "蓝牙已关闭,请先打开");
                return out;
            }
            ensureReceiver(c);
            found.clear();
            try { if (a.isDiscovering()) a.cancelDiscovery(); } catch (Throwable ignored) {}
            boolean started = false;
            try { started = a.startDiscovery(); } catch (Throwable t) {}
            if (started) {
                int i = 0;
                while (i < 26 && (discovering || i < 8) && found.size() < 24) {
                    Thread.sleep(500);
                    i++;
                    if (!discovering && i > 8) break;
                }
                try { a.cancelDiscovery(); } catch (Throwable ignored) {}
            }
            JSONArray arr = new JSONArray();
            Set<String> seen = new LinkedHashSet<String>();
            try {
                Set<BluetoothDevice> bs = a.getBondedDevices();
                if (bs != null) for (BluetoothDevice d : bs) {
                    String mac = "";
                    try { mac = d.getAddress(); } catch (Throwable ignored) {}
                    if (mac != null) { seen.add(mac); arr.put(devJson(d, 0, true)); }
                }
            } catch (Throwable ignored) {}
            synchronized (found) {
                for (String k : found.keySet()) {
                    if (seen.contains(k)) continue;
                    seen.add(k);
                    arr.put(found.get(k));
                }
            }
            out.put("ok", true);
            out.put("list", arr);
            out.put("discovering", started);
            out.put("msg", (started ? "扫描完成" : "系统未开始扫描(可能正在扫描中)") + ",共 " + arr.length() + " 个设备");
        } catch (Throwable t) {
            try { out.put("ok", false); out.put("msg", "扫描失败:" + t); } catch (Throwable ignored) {}
        }
        return out;
    }

    public static JSONObject btPair(Context c, String mac) {
        JSONObject out = new JSONObject();
        try {
            BluetoothAdapter a = bt();
            if (a == null) { out.put("ok", false); out.put("msg", "本机没有蓝牙硬件"); return out; }
            if (missingBt(c).size() > 0) { ensurePerms(c, false, true); out.put("ok", false); out.put("needPerm", true); out.put("msg", "需要「附近的设备」权限"); return out; }
            if (mac == null || mac.length() == 0) { out.put("ok", false); out.put("msg", "MAC 为空"); return out; }
            BluetoothDevice d = a.getRemoteDevice(mac);
            if (d.getBondState() == BluetoothDevice.BOND_BONDED) { out.put("ok", true); out.put("msg", "已配对"); return out; }
            boolean r = d.createBond();
            out.put("ok", r);
            out.put("msg", r ? "已发起配对,系统可能弹出配对码确认框" : "配对请求被系统拒绝");
        } catch (Throwable t) {
            try { out.put("ok", false); out.put("msg", "配对失败:" + t); } catch (Throwable ignored) {}
        }
        return out;
    }

    /* 连接已配对设备:优先 A2DP(音箱/耳机),失败提示去系统设置点设备 */
    public static JSONObject btConnect(Context c, String mac) {
        JSONObject out = new JSONObject();
        try {
            BluetoothAdapter a = bt();
            if (a == null) { out.put("ok", false); out.put("msg", "本机没有蓝牙硬件"); return out; }
            if (mac == null || mac.length() == 0) { out.put("ok", false); out.put("msg", "MAC 为空"); return out; }
            BluetoothDevice d = a.getRemoteDevice(mac);
            if (d.getBondState() != BluetoothDevice.BOND_BONDED) {
                out.put("ok", false); out.put("msg", "该设备还没配对,请先点「配对」");
                return out;
            }
            Object proxy = a2dpProxy(c);
            if (proxy != null) {
                try {
                    java.lang.reflect.Method m = proxy.getClass().getMethod("connect", BluetoothDevice.class);
                    Object r = m.invoke(proxy, d);
                    boolean okC = (r instanceof Boolean) && ((Boolean) r).booleanValue();
                    out.put("ok", okC);
                    out.put("mode", "a2dp");
                    out.put("msg", okC ? "已向系统发起 A2DP 连接(音箱/耳机)" : "A2DP 连接被拒绝,请到系统蓝牙设置里点该设备");
                    return out;
                } catch (Throwable t) {
                    out.put("ok", false);
                    out.put("msg", "系统不允许应用直接连接,请在系统蓝牙设置里点选该设备");
                }
            } else {
                out.put("ok", false);
                out.put("msg", "系统未提供音频连接通道,请在系统蓝牙设置里点选该设备");
            }
            out.put("needSettings", true);
        } catch (Throwable t) {
            try { out.put("ok", false); out.put("msg", "连接失败:" + t); } catch (Throwable ignored) {}
        }
        return out;
    }

    private static Object a2dpProxy(Context c) {
        final java.util.concurrent.BlockingQueue<Object> q = new java.util.concurrent.LinkedBlockingQueue<Object>();
        try {
            android.bluetooth.BluetoothProfile.ServiceListener l = new android.bluetooth.BluetoothProfile.ServiceListener() {
                public void onServiceConnected(int profile, android.bluetooth.BluetoothProfile proxy) { q.offer(proxy); }
                public void onServiceDisconnected(int profile) {}
            };
            if (!bt().getProfileProxy(c, l, android.bluetooth.BluetoothProfile.A2DP)) return null;
            return q.poll(3, java.util.concurrent.TimeUnit.SECONDS);
        } catch (Throwable t) { return null; }
    }

    public static void requestBtEnable(Context c) {
        openSettings(c, BluetoothAdapter.ACTION_REQUEST_ENABLE);
    }

    public static void openBtSettings(Context c) {
        openSettings(c, Settings.ACTION_BLUETOOTH_SETTINGS);
    }

    /* ---------------- 汇总 ---------------- */
    public static JSONObject info(Context c) {
        JSONObject o = new JSONObject();
        try {
            o.put("ok", true);
            o.put("platform", "android");
            o.put("sdk", Build.VERSION.SDK_INT);
            o.put("model", Build.MODEL == null ? "" : Build.MODEL);
            o.put("brand", Build.BRAND == null ? "" : Build.BRAND);
            o.put("wifi", wifiState(c));
            o.put("bt", btState(c));
        } catch (Throwable t) {}
        return o;
    }
}
