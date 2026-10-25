# -*- coding: utf-8 -*-
# AMUTV 应用图标:小电视版 —— 复刻应用顶栏复古小电视 logo(白机身/黑屏TV字/天线/支脚)
# 黑渐变圆角底 + 琥珀氛围光;输出:安卓全密度 mipmap + legacy 根 + PWA PNG
import os
from PIL import Image, ImageDraw, ImageFont, ImageFilter

ROOT = os.path.dirname(os.path.abspath(__file__))
S = 1024

def lerp(a, b, t):
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))

def v_gradient(size, stops):
    w, h = size
    strip = Image.new("RGB", (1, h))
    px = strip.load()
    for y in range(h):
        t = y / (h - 1)
        for i in range(len(stops) - 1):
            p0, c0 = stops[i]; p1, c1 = stops[i + 1]
            if p0 <= t <= p1:
                px[0, y] = lerp(c0, c1, (t - p0) / (p1 - p0 or 1))
                break
    return strip.resize(size)

def rounded_mask(size, box, r):
    m = Image.new("L", size, 0)
    d = ImageDraw.Draw(m)
    d.rounded_rectangle(box, radius=r, fill=255)
    return m

img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
bg = v_gradient((S, S), [(0.0, (23, 23, 29)), (0.55, (14, 14, 17)), (1.0, (8, 8, 10))])
img.paste(bg, (0, 0))
img.putalpha(rounded_mask((S, S), (0, 0, S - 1, S - 1), 200))

# 琥珀氛围光晕(电视后方)
glow = Image.new("RGBA", (S, S), (0, 0, 0, 0))
gd = ImageDraw.Draw(glow)
gd.ellipse((170, 200, 854, 860), fill=(255, 179, 0, 70))
glow = glow.filter(ImageFilter.GaussianBlur(150))
img = Image.alpha_composite(img, glow)
img.putalpha(rounded_mask((S, S), (0, 0, S - 1, S - 1), 200))

draw = ImageDraw.Draw(img)

WHITE = (245, 245, 247, 255)
SCREEN = (10, 10, 13, 255)

# 顶栏 logo 几何 ×13,整体下移 70 居中
K, OX, OY = 13, 96, 70
def P(x, y):
    return (x * K + OX, y * K + OY)

# --- 天线(双线+端点圆珠) ---
ant_w = 30
draw.line([P(32, 17), P(22, 5)], fill=WHITE, width=ant_w)
draw.line([P(32, 17), P(42, 5)], fill=WHITE, width=ant_w)
for (x, y) in [(22, 5), (42, 5), (32, 17)]:
    px, py = P(x, y)
    r = 15
    draw.ellipse((px - r, py - r, px + r, py + r), fill=WHITE)

# --- 机身(白,圆角) ---
bx0, by0 = P(8, 15); bx1, by1 = P(56, 56)
draw.rounded_rectangle((bx0, by0, bx1, by1), radius=143, fill=WHITE)
# 机身底缘细阴影线增加立体感
draw.rounded_rectangle((bx0, by0, bx1, by1), radius=143, outline=(0, 0, 0, 40), width=3)

# --- 屏幕(黑,内嵌) ---
sx0, sy0 = P(14, 21); sx1, sy1 = P(50, 50)
draw.rounded_rectangle((sx0, sy0, sx1, sy1), radius=91, fill=SCREEN)

# --- 屏幕 TV 字样 ---
font = ImageFont.truetype(r"C:\Windows\Fonts\arialbd.ttf", 200)
txt = "TV"
bb = draw.textbbox((0, 0), txt, font=font)
tw, th = bb[2] - bb[0], bb[3] - bb[1]
cx, cy = P(32, 42.5)
draw.text((cx - tw / 2 - bb[0], cy - th / 2 - bb[1]), txt, font=font, fill=WHITE)

# --- 支脚 ---
for x in [(17, 23), (41, 47)]:
    fx0, fy0 = P(x[0], 56); fx1, fy1 = P(x[1], 60)
    draw.rounded_rectangle((fx0, fy0, fx1, fy1), radius=20, fill=WHITE)

out = img.resize((512, 512), Image.LANCZOS)

DENS = {"mdpi": 48, "hdpi": 72, "xhdpi": 96, "xxhdpi": 144, "xxxhdpi": 192}
for d, px in DENS.items():
    p = os.path.join(ROOT, "android", "res", "mipmap-" + d)
    os.makedirs(p, exist_ok=True)
    out.resize((px, px), Image.LANCZOS).save(os.path.join(p, "ic_launcher.png"))
legacy = os.path.join(ROOT, "android", "res", "mipmap")
if os.path.isdir(legacy):
    out.resize((192, 192), Image.LANCZOS).save(os.path.join(legacy, "ic_launcher.png"))

os.makedirs(os.path.join(ROOT, "icons"), exist_ok=True)
out.resize((192, 192), Image.LANCZOS).save(os.path.join(ROOT, "icons", "icon-192.png"))
out.save(os.path.join(ROOT, "icons", "icon-512.png"))
out.save(os.path.join(ROOT, "icons", "icon-preview.png"))
print("TV icon generated OK")
