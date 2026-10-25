# -*- coding: utf-8 -*-
"""把 www/ 拍平成 assets-flat/:所有文件移到根目录,目录分隔符换下划线。
index.html 的相对引用同步改写。规避部分模拟器 ROM 的 AssetManager
反斜杠/子目录缺陷(WebView 正斜杠请求 404 问题)。"""
import io
import os
import re
import shutil

ROOT = os.path.dirname(os.path.abspath(__file__))
SRC = ROOT                       # 直接取项目根(最新代码)
DST = os.path.join(ROOT, 'android', 'assets-flat')

COPY_ITEMS = ['index.html', 'remote.html', 'push.html', 'css', 'js', 'vendor', 'icons', 'media', 'manifest.json']

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
        shutil.copyfile(src, os.path.join(DST, flat))
        count += 1
        continue
    for base, _dirs, files in os.walk(src):
        rel = os.path.relpath(base, SRC)
        for f in files:
            flat = 'www_' + rel.replace('\\', '_').replace('/', '_') + '_' + f
            shutil.copyfile(os.path.join(base, f), os.path.join(DST, flat))
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
