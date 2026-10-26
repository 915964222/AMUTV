import json, urllib.parse, urllib.request, re, sys

PROXY = "http://127.0.0.1:9978/proxy/"
SOURCES = [
    ("量子资源", "https://cj.lziapi.com/api.php/provide/vod/"),
    ("非凡资源", "https://api.ffzyapi.com/api.php/provide/vod/"),
    ("红牛资源", "https://hongniuzy2.com/api.php/provide/vod/"),
    ("电影天堂", "http://caiji.dyttzyapi.com/api.php/provide/vod/"),
    ("暴风资源", "https://bfzyapi.com/api.php/provide/vod/"),
    ("360资源",  "https://360zy.com/api.php/provide/vod/"),
]
WD = urllib.parse.quote("璀璨之城")


def proxy_get(url, timeout=40):
    enc = urllib.parse.quote(url, safe="")
    req = urllib.request.Request(PROXY + enc, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read().decode("utf-8", "replace")


def probe(url, timeout=25):
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"}, method="GET")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            ct = r.headers.get("Content-Type", "?")
            body = r.read(400).decode("utf-8", "replace")
    except Exception as e:
        return "ERR " + str(e)[:50]
    cl = ct.lower()
    if "html" in cl or body.lstrip()[:1] == "<":
        return "HTML页"
    if "mpegurl" in cl or ".m3u8" in url.lower():
        return "m3u8直链"
    if "video/mp4" in cl or ".mp4" in url.lower():
        return "mp4直链"
    return "其他:" + ct[:30]


for name, base in SOURCES:
    try:
        raw = proxy_get(base + "?ac=detail&wd=" + WD)
        j = json.loads(raw)
    except Exception as e:
        print(f"### {name}: 接口失败 {e}")
        continue
    lst = j.get("list") or []
    if not lst:
        print(f"### {name}: 无结果")
        continue
    v = lst[0]
    froms = str(v.get("vod_play_from", "")).split("$$$")
    pus = str(v.get("vod_play_url", "")).split("#")
    print(f"### {name}  ({v.get('vod_name')})")
    for i, f in enumerate(froms):
        seg = pus[i] if i < len(pus) else ""
        first = seg.split("$")[1] if "$" in seg else ""
        kind = probe(first) if first else "无URL"
        print(f"    线路[{f}]: {kind:12s} {first[:88]}")
    sys.stdout.flush()
