# -*- coding: utf-8 -*-
"""把 www/ 拍平成 assets-flat/:所有文件移到根目录,目录分隔符换下划线。
index.html 的相对引用同步改写。规避部分模拟器 ROM 的 AssetManager
反斜杠/子目录缺陷(WebView 正斜杠请求 404 问题)。

补充(TV 盒子兼容修复):
  - ad-rules.js 之前从未被打进 APK,这里补进 COPY_ITEMS 并拍平引用。
  - 所有 .js(含 vendor/hls.min.js 里用到的 ?. )统一用 esbuild 降级到
    ES2015(ES6)。老 TV 盒子的 WebView(如 Android 9 = Chromium 74)无法解析
    ?? / ?. 等新版语法,脚本直接抛 SyntaxError 导致整页白屏。降级后覆盖
    Android 5.1+(Chromium 45+) 的盒子,可正常解析运行。
"""
import io
import os
import re
import shutil
import subprocess
import sys

ROOT = os.path.dirname(os.path.abspath(__file__))
SRC = ROOT                       # 直接取项目根(最新代码)
DST = os.path.join(ROOT, 'android', 'assets-flat')

# esbuild 目标语法:ES2015(ES6)
TARGET = "es2015"

COPY_ITEMS = ['index.html', 'remote.html', 'push.html', 'ad-rules.js',
              'css', 'js', 'vendor', 'icons', 'media', 'manifest.json',
              'verify1080.html']


def find_esbuild():
    """在常见位置查找 esbuild 可执行文件(构建期工具,零运行时依赖)。"""
    base = os.path.join(ROOT, 'node_modules', '.bin', 'esbuild')
    managed = r"C:\Users\91596\.workbuddy\binaries\node\workspace\node_modules\.bin\esbuild"
    candidates = [managed, base, 'esbuild']
    for c in candidates:
        if not c:
            continue
        # 直接尝试
        try:
            subprocess.run([c, '--version'], capture_output=True, text=True, timeout=15)
            return c
        except Exception:
            pass
        # Windows 下尝试 .cmd 形式
        if os.name == 'nt' and not c.lower().endswith('.cmd'):
            try:
                subprocess.run([c + '.cmd', '--version'], capture_output=True, text=True, timeout=15)
                return c + '.cmd'
            except Exception:
                pass
    return None


ESBUILD = find_esbuild()
if ESBUILD:
    print('[prepare] esbuild found:', ESBUILD, '-> target', TARGET)
else:
    sys.stderr.write('[prepare][WARN] esbuild not found; JS will NOT be transpiled '
                     '(APK may白屏 on old TV WebView). Install esbuild to fix.\n')


def transpile(src):
    """用 esbuild 把单个 JS 文件降级到 TARGET 语法;失败则原样返回。"""
    if not ESBUILD:
        with io.open(src, encoding='utf-8') as f:
            return f.read()
    try:
        with io.open(src, encoding='utf-8') as f:
            data = f.read()
        p = subprocess.run([ESBUILD, '--target=' + TARGET], input=data,
                           capture_output=True, text=True, timeout=60)
        if p.returncode == 0 and p.stdout:
            return p.stdout
        sys.stderr.write('[prepare][WARN] esbuild failed for %s: %s\n' % (src, p.stderr.strip()))
    except Exception as e:
        sys.stderr.write('[prepare][WARN] transpile error %s: %s\n' % (src, e))
    with io.open(src, encoding='utf-8') as f:
        return f.read()


if os.path.isdir(DST):
    shutil.rmtree(DST)
os.makedirs(DST)

count = 0
for item in COPY_ITEMS:
    src = os.path.join(SRC, item)
    if not os.path.exists(src):
        continue
    if os.path.isfile(src):
        flat = 'www_' + item
        if item.endswith('.js'):
            io.open(os.path.join(DST, flat), 'w', encoding='utf-8').write(transpile(src))
        else:
            shutil.copyfile(src, os.path.join(DST, flat))
        count += 1
        continue
    for base, _dirs, files in os.walk(src):
        rel = os.path.relpath(base, SRC)
        for f in files:
            flat = 'www_' + rel.replace('\\', '_').replace('/', '_') + '_' + f
            s = os.path.join(base, f)
            if f.endswith('.js'):
                io.open(os.path.join(DST, flat), 'w', encoding='utf-8').write(transpile(s))
            else:
                shutil.copyfile(s, os.path.join(DST, flat))
            count += 1

html = io.open(os.path.join(DST, 'www_index.html'), encoding='utf-8').read()
html = re.sub(r'<link rel="manifest"[^>]*>\n?', '', html)
html = re.sub(r'<script>\s*if \(\'serviceWorker\'[\s\S]*?</script>\n?', '', html)

# 通用重写:src/href 引用 → 拍平文件名(去 ?v= 查询串,分隔符换下划线);
# 覆盖所有本地资源,新增 js 文件(cloud/scraper/live/danmaku 等)自动适配
def flatten_ref(m):
    attr, path = m.group(1), m.group(2)
    if re.match(r'^[a-z][a-z0-9+.-]*:', path, re.I) or path.startswith('//'):
        return m.group(0)  # 外链不动
    clean = path.split('?')[0].split('#')[0].lstrip('/')
    flat = 'www_' + clean.replace('/', '_')
    if os.path.exists(os.path.join(DST, flat)):
        return attr + '="' + flat + '"'
    return m.group(0)

html = re.sub(r'(src|href)="([^"]+)"', flatten_ref, html)
io.open(os.path.join(DST, 'www_index.html'), 'w', encoding='utf-8').write(html)
if os.path.exists(os.path.join(DST, 'www_manifest.json')):
    os.remove(os.path.join(DST, 'www_manifest.json'))

print('assets-flat files:', count)
