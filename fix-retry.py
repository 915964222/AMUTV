# -*- coding: utf-8 -*-
import io

p = r'C:\Users\91596\.zcode\workspace\17e4ecba-c7c4-40ce-b117-87a9e9f578b3\tvbox-web\js\api.js'
s = io.open(p, encoding='utf-8').read()

old = """  async function fetchText(url, timeout = 12000) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeout);
    try {
      const res = await fetch(proxied(url), { signal: ctl.signal, headers: { 'Accept': 'application/json, text/plain, */*' } });
      if (!res.ok) {
        let body = '';
        try { body = (await res.text()).slice(0, 90); } catch {}
        throw new Error(friendlyNetError(body || ('HTTP ' + res.status)));
      }
      return await res.text();
    } catch (e) {
      if (e.name === 'AbortError') throw new Error('请求超时(' + (timeout / 1000) + 's),源响应太慢或不可达');
      throw new Error(friendlyNetError(e.message || e));
    } finally { clearTimeout(timer); }
  }"""
new = """  async function fetchTextOnce(url, timeout) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeout);
    try {
      const res = await fetch(proxied(url), { signal: ctl.signal, headers: { 'Accept': 'application/json, text/plain, */*' } });
      if (!res.ok) {
        let body = '';
        try { body = (await res.text()).slice(0, 90); } catch {}
        throw new Error(friendlyNetError(body || ('HTTP ' + res.status)));
      }
      return await res.text();
    } catch (e) {
      if (e.name === 'AbortError') throw new Error('请求超时(' + (timeout / 1000) + 's),源响应太慢或不可达');
      throw new Error(friendlyNetError(e.message || e));
    } finally { clearTimeout(timer); }
  }
  /* 带重试:部分上游连接会偶发中途重置(Failed to fetch / ECONNRESET) */
  async function fetchText(url, timeout = 12000) {
    let lastErr = null;
    for (let i = 0; i < 3; i++) {
      try { return await fetchTextOnce(url, timeout); }
      catch (e) {
        lastErr = e;
        if (/超时/.test(e.message)) throw e;   // 超时不重试(可能源真死)
        await new Promise(r => setTimeout(r, 600 * (i + 1)));
      }
    }
    throw lastErr;
  }"""
assert old in s, 'fetchText anchor missing'
s = s.replace(old, new)

io.open(p, 'w', encoding='utf-8').write(s)
print('retry added')
