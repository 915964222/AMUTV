import json, urllib.parse, urllib.request, re, sys

PROXY = "http://127.0.0.1:9978/proxy/"
SOURCES = [
    ("量子资源",   "https://cj.lziapi.com/api.php/provide/vod/"),
    ("非凡资源",   "https://api.ffzyapi.com/api.php/provide/vod/"),
    ("暴风资源",   "https://bfzyapi.com/api.php/provide/vod/"),
    ("红牛资源",   "https://hongniuzy2.com/api.php/provide/vod/"),
    ("360资源",    "https://360zy.com/api.php/provide/vod/"),
    ("极速资源",   "https://jszyapi.com/api.php/provide/vod/"),
    ("豪华资源",   "https://hhzyapi.com/api.php/provide/vod/"),
    ("电影天堂",   "http://caiji.dyttzyapi.com/api.php/provide/vod/"),
]
WD = urllib.parse.quote("璀璨之城")


def proxy_get(url, timeout=35):
    enc = urllib.parse.quote(url, safe="")
    req = urllib.request.Request(PROXY + enc, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read().decode("utf-8", "replace")


def head(url, timeout=25):
    """返回 (状态, Content-Type, 是否像HTML)"""
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"}, method="GET")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            body = r.read(600)
            ct = r.headers.get("Content-Type", "?")
            return r.status, ct, body[:200].decode("utf-8", "replace")
    except Exception as e:
        return "ERR", str(e)[:60], ""


def classify(url):
    st, ct, head_txt = head(url)
    if st == "ERR":
        return "ERR:" + ct, ""
    low = (ct + " " + head_txt[:120]).lower()
    if "html" in ct.lower() or head_txt.lstrip()[:1] == "<":
        return "HTML页面(不可直接播)", ct
    if ".m3u8" in url.lower() or "mpegurl" in ct.lower():
        return "m3u8 直链", ct
    if ".mp4" in url.lower() or "video/mp4" in ct.lower():
        return "mp4 直链", ct
    if "javascript" in low or "video/" in ct.lower():
        return "其他媒体(" + ct + ")", ct
    return "未知(" + ct + ")", ct


for name, base in SOURCES:
    url = base + "?ac=detail&wd=" + WD
    try:
        raw = proxy_get(url)
    except Exception as e:
        print(f"{name:8s} 接口失败: {e}")
        continue
    try:
        j = json.loads(raw)
    except Exception:
        print(f"{name:8s} 非JSON返回(前80字): {raw[:80]!r}")
        continue
    lst = j.get("list") or []
    if not lst:
        print(f"{name:8s} 无匹配结果")
        continue
    v = lst[0]
    pf = str(v.get("vod_play_from", ""))
    pu = str(v.get("vod_play_url", ""))
    first = pu.split("#")[0]
    m = re.search(r"\$([^$]+)", first)
    play = m.group(1) if m else first
    kind, ct = classify(play)
    print(f"{name:8s} | 线路: {pf[:28]:28s} | {kind:22s} | {play[:70]}")
    sys.stdout.flush()
