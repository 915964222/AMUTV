#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""GitHub Release 发布助手（仅用标准库）
用法:
  python tools/gh-release.py check
  python tools/gh-release.py create <tag> <title> <notes_file>
  python tools/gh-release.py upload <tag> <asset_path>
"""
import io
import json
import os
import subprocess
import sys
import urllib.request

REPO = '915964222/AMUTV'
API = 'https://api.github.com'
UA = 'amutv-release-bot'


def get_token():
    p = subprocess.run(['git', 'credential', 'fill'],
                       input=b'protocol=https\nhost=github.com\n\n',
                       stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    for line in p.stdout.decode('utf-8', 'replace').splitlines():
        if line.startswith('password='):
            return line.split('=', 1)[1]
    raise SystemExit('no token')


TOKEN = get_token()


def req(method, path, data=None, raw=None, ctype='application/json'):
    url = path if path.startswith('http') else API + path
    if raw is not None:
        body = raw
    elif data is not None:
        body = json.dumps(data).encode('utf-8')
    else:
        body = None
    r = urllib.request.Request(url, data=body, method=method)
    r.add_header('Authorization', 'token ' + TOKEN)
    r.add_header('Accept', 'application/vnd.github+json')
    r.add_header('User-Agent', UA)
    if body is not None:
        r.add_header('Content-Type', ctype)
    try:
        with urllib.request.urlopen(r, timeout=90) as resp:
            txt = resp.read().decode('utf-8', 'replace')
            return resp.status, (json.loads(txt) if txt.strip().startswith(('{', '[')) else txt)
    except urllib.error.HTTPError as e:
        txt = e.read().decode('utf-8', 'replace')
        return e.code, txt


def cmd_check():
    s, d = req('GET', '/repos/' + REPO)
    print('repo ->', s)
    if isinstance(d, dict):
        print('  private =', d.get('private'), '| default_branch =', d.get('default_branch'))
        print('  permissions =', d.get('permissions'))
    else:
        print('  body:', str(d)[:200])
    s2, d2 = req('GET', '/repos/%s/releases?per_page=5' % REPO)
    print('releases ->', s2, '| count =', len(d2) if isinstance(d2, list) else d2)
    if isinstance(d2, list):
        for r in d2:
            print('   -', r.get('tag_name'), [(a['name'], round(a['size'] / 1048576, 2)) for a in r.get('assets', [])])
    s3, d3 = req('GET', '/repos/%s/git/ref/tags/v1.3' % REPO)
    print('remote tag v1.3 ->', s3)
    s4, d4 = req('GET', '/repos/%s/commits/main' % REPO)
    if isinstance(d4, dict):
        print('remote main =', d4.get('sha', '')[:7], '|', (d4.get('commit', {}).get('message') or '').splitlines()[0][:50])


def cmd_create(tag, title, notes_file):
    notes = io.open(notes_file, encoding='utf-8').read()
    s, d = req('POST', '/repos/%s/releases' % REPO, {
        'tag_name': tag,
        'name': title,
        'body': notes,
        'draft': False,
        'prerelease': False,
    })
    print('create release ->', s)
    if s in (200, 201):
        print('  id =', d.get('id'), '| upload_url =', d.get('upload_url'))
        return d
    print('  body:', str(d)[:400])
    sys.exit(1)


def cmd_upload(tag, path):
    s, d = req('GET', '/repos/%s/releases/tags/%s' % (REPO, tag))
    if s != 200:
        raise SystemExit('release not found: %s %s' % (s, str(d)[:200]))
    rid = d['id']
    for a in d.get('assets', []):
        if a['name'] == os.path.basename(path):
            print('delete old asset', a['id'])
            req('DELETE', '/repos/%s/releases/assets/%s' % (REPO, a['id']))
    raw = open(path, 'rb').read()
    name = os.path.basename(path)
    url = 'https://uploads.github.com/repos/%s/releases/%s/assets?name=%s' % (REPO, rid, name)
    print('uploading %s (%d bytes) ...' % (name, len(raw)))
    s, d = req('POST', url, raw=raw, ctype='application/vnd.android.package-archive')
    print('upload ->', s)
    if s in (200, 201):
        print('  browser_download_url =', d.get('browser_download_url'))
        print('  size =', d.get('size'), '| state =', d.get('state'))
        return
    print('  body:', str(d)[:400])
    sys.exit(1)


def main():
    a = sys.argv[1:]
    if not a:
        raise SystemExit(__doc__)
    if a[0] == 'check':
        cmd_check()
    elif a[0] == 'create':
        cmd_create(a[1], a[2], a[3])
    elif a[0] == 'upload':
        cmd_upload(a[1], a[2])
    else:
        raise SystemExit(__doc__)


if __name__ == '__main__':
    main()
