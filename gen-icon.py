# -*- coding: utf-8 -*-
# AMUTV 应用图标重绘:近黑渐变底 + 鎏金发光屏幕 + AMU 字样 + 天线
# 输出:安卓全密度 mipmap + legacy 根 + PWA PNG 192/512
import io, math, os
from PIL import Image, ImageDraw, ImageFont, ImageFilter

ROOT = os.path.dirname(os.path.abspath(__file__))
S = 1024  # 超采样画布

def lerp(a, b, t):
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))

def v_gradient(size, stops):
    """垂直渐变:stops=[(pos0-1,color),...];返回 RGB 图"""
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
gd.ellipse((160, 230, 864, 830), fill=(255, 179, 0, 80))
gd.ellipse((260, 320, 764, 740), fill=(255, 200, 90, 60))
glow = glow.filter(ImageFilter.GaussianBlur(150))
img = Image.alpha_composite(img, glow)
img.putalpha(rounded_mask((S, S), (0, 0, S - 1, S - 1), 200))

draw = ImageDraw.Draw(img)

GOLD = [(0.0, (252, 229, 186)), (0.45, (237, 187, 110)), (1.0, (196, 138, 55))]
DARK_TXT = (34, 20, 5, 255)

def rounded_rect_img(box, r, im):
    """按圆角矩形贴图"""
    m = rounded_mask(im.size, (0, 0, im.size[0] - 1, im.size[1] - 1), r)
    img.paste(im, (box[0], box[1]), m)

# --- 天线(先画,压在机身后) ---
ant_c = (237, 181, 99)
draw.line([(396, 336), (486, 148)], fill=ant_c, width=20)
draw.line([(628, 336), (538, 148)], fill=ant_c, width=20)
for p in [(396, 336), (628, 336), (486, 148), (538, 148)]:
    r = 10
    draw.ellipse((p[0] - r, p[1] - r, p[0] + r, p[1] + r), fill=ant_c)

# --- 机身(深色边框) ---
draw.rounded_rectangle((172, 318, 852, 706), radius=44, fill=(11, 11, 14, 255))
draw.rounded_rectangle((172, 318, 852, 706), radius=44, outline=(255, 255, 255, 18), width=3)

# --- 鎏金屏幕 ---
screen = v_gradient((600, 348), GOLD)
rounded_rect_img((212, 338, 212 + 600, 338 + 348), 26, screen)

# 屏幕内高光(上部柔白横带)
hl = Image.new("RGBA", (S, S), (0, 0, 0, 0))
hd = ImageDraw.Draw(hl)
hd.rounded_rectangle((212, 338, 812, 430), radius=26, fill=(255, 255, 255, 46))
hl = hl.filter(ImageFilter.GaussianBlur(28))
img = Image.alpha_composite(img, hl)
draw = ImageDraw.Draw(img)

# --- AMU 字样 ---
font = ImageFont.truetype(r"C:\Windows\Fonts\arialbd.ttf", 172)
txt = "AMU"
bb = draw.textbbox((0, 0), txt, font=font)
tw, th = bb[2] - bb[0], bb[3] - bb[1]
tx = 512 - tw / 2 - bb[0]
ty = 512 - th / 2 - bb[1]
draw.text((tx, ty), txt, font=font, fill=DARK_TXT)

# --- 底座 ---
draw.rounded_rectangle((462, 706, 562, 756), radius=12, fill=(38, 38, 44, 255))
draw.rounded_rectangle((372, 756, 652, 796), radius=18, fill=(28, 28, 33, 255))
draw.rounded_rectangle((372, 756, 652, 796), radius=18, outline=(255, 255, 255, 16), width=2)

out = img.resize((512, 512), Image.LANCZOS)

# --- 安卓 mipmap ---
DENS = {"mdpi": 48, "hdpi": 72, "xhdpi": 96, "xxhdpi": 144, "xxxhdpi": 192}
for d, px in DENS.items():
    p = os.path.join(ROOT, "android", "res", "mipmap-" + d)
    os.makedirs(p, exist_ok=True)
    out.resize((px, px), Image.LANCZOS).save(os.path.join(p, "ic_launcher.png"))
# legacy 根路径(与 xxxhdpi 同图)
legacy = os.path.join(ROOT, "android", "res", "mipmap")
if os.path.isdir(legacy):
    out.resize((192, 192), Image.LANCZOS).save(os.path.join(legacy, "ic_launcher.png"))

# --- PWA PNG ---
os.makedirs(os.path.join(ROOT, "icons"), exist_ok=True)
out.resize((192, 192), Image.LANCZOS).save(os.path.join(ROOT, "icons", "icon-192.png"))
out.save(os.path.join(ROOT, "icons", "icon-512.png"))
out.save(os.path.join(ROOT, "icons", "icon-preview.png"))
print("icons generated OK")
