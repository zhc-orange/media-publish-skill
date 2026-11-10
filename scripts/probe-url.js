'use strict';

/**
 * 针对单个 URL 的深度探针：打开页面 → 返回最终 URL / 关键 Cookie（含过期时间）/ 页面文字。
 * 用法：node probe-url.js <port> <url>
 */

const http = require('node:http');

const PORT = Number(process.argv[2] || 9341);
const URL_TARGET = process.argv[3];
if (!URL_TARGET) {
  console.error('用法：node probe-url.js <port> <url>');
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function getJson(url, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => {
        try {
          resolve(JSON.parse(d));
        } catch (e) {
          reject(new Error('bad json'));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      reject(new Error('timeout'));
    });
  });
}

class Cdp {
  constructor(ws) {
    this.wsUrl = ws;
    this.seq = 0;
    this.pending = new Map();
  }
  async connect() {
    this.ws = new WebSocket(this.wsUrl, { maxPayload: 64 * 1024 * 1024 });
    await new Promise((res, rej) => {
      this.ws.addEventListener('open', () => res());
      this.ws.addEventListener('error', () => rej(new Error('ws error')));
    });
    this.ws.addEventListener('message', (ev) => {
      let m;
      try {
        m = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data));
      } catch (e) {
        return;
      }
      if (m.id && this.pending.has(m.id)) {
        const p = this.pending.get(m.id);
        this.pending.delete(m.id);
        if (m.error) p.reject(new Error(m.error.message));
        else p.resolve(m.result);
      }
    });
  }
  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.seq;
      const t = setTimeout(() => reject(new Error('timeout ' + method)), 30000);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(t);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(t);
          reject(e);
        },
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  close() {
    try {
      this.ws.close();
    } catch (e) {}
  }
}

async function main() {
  // 用 PUT 新建标签页（GET 会被拒）
  const target = await new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: PORT, path: `/json/new?${encodeURIComponent(URL_TARGET)}`, method: 'PUT' },
      (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(d));
          } catch (e) {
            reject(new Error('bad json: ' + d.slice(0, 100)));
          }
        });
      }
    );
    req.on('error', reject);
    req.end();
  });

  const cdp = new Cdp(target.webSocketDebuggerUrl);
  await cdp.connect();
  await sleep(12000);

  const res = await cdp.send('Runtime.evaluate', {
    expression: `(function(){
      var body = document.body ? document.body.innerText : '';
      return {
        url: location.href,
        title: document.title,
        bodyLen: body.length,
        head: body.replace(/\\s+/g,' ').slice(0, 200),
        docCookieNames: document.cookie ? document.cookie.split(';').map(function(s){return s.split('=')[0].trim()}) : []
      };
    })()`,
    returnByValue: true,
  });

  await cdp.send('Network.enable');
  const all = await cdp.send('Network.getAllCookies');
  const host = new URL(URL_TARGET).hostname.split('.').slice(-2).join('.');
  const cookies = (all.cookies || [])
    .filter((c) => String(c.domain).indexOf(host) >= 0)
    .map((c) => ({
      name: c.name,
      domain: c.domain,
      path: c.path,
      secure: c.secure,
      httpOnly: c.httpOnly,
      expires: c.expires > 0 ? new Date(c.expires * 1000).toISOString().slice(0, 19) : 'session',
      expired: c.expires > 0 ? c.expires * 1000 < Date.now() : false,
    }))
    .sort((a, b) => (a.name > b.name ? 1 : -1));

  console.log(
    JSON.stringify(
      {
        target: URL_TARGET,
        page: res && res.result ? res.result.value : null,
        cookieCount: cookies.length,
        cookies,
      },
      null,
      2
    )
  );

  cdp.close();
  // 关掉这个标签页
  await getJson(`http://127.0.0.1:${PORT}/json/close/${target.id}`).catch(() => {});
}

main().catch((e) => {
  console.error('PROBE_FAILED:', e.message);
  process.exit(1);
});
