'use strict';

/**
 * 诊断每个标签页的真实状态：URL、是否登录、登录判据命中项、Cookie 是否存在。
 * 只读。用法：node diag.js [port]
 */

const http = require('node:http');

const PORT = Number(process.argv[2] || 9341);

function getJson(url, timeoutMs = 2000) {
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

const EVAL = `(function(){
  var norm = function(s){ return String(s==null?'':s).replace(/\\s+/g,' ').trim(); };
  var body = document.body ? document.body.innerText : '';
  var files = document.querySelectorAll('input[type=file]').length;
  var avatars = 0;
  ['[class*=avatar]','[class*=Avatar]','[class*=user-info]','[class*=userInfo]','ytcp-avatar','#avatar-btn','[data-e2e="profile-icon"]'].forEach(function(sel){
    try { if (document.querySelector(sel)) avatars++; } catch(e){}
  });
  return {
    url: location.href,
    title: document.title,
    bodyLen: body.length,
    fileInputs: files,
    avatarHits: avatars,
    loginWords: ['扫码登录','密码登录','验证码登录','手机号登录','立即登录','Sign in','登录后'].filter(function(w){ return body.indexOf(w) >= 0; }),
    head: norm(body).slice(0, 90)
  };
})()`;

async function main() {
  const list = await getJson(`http://127.0.0.1:${PORT}/json/list`);
  const pages = list.filter((t) => t.type === 'page' && !/devtools/.test(t.url));
  const out = [];
  for (const p of pages) {
    let info = { url: p.url };
    try {
      const cdp = new Cdp(p.webSocketDebuggerUrl);
      await cdp.connect();
      const res = await cdp.send('Runtime.evaluate', { expression: EVAL, returnByValue: true });
      info = res && res.result ? res.result.value : info;
      // 顺带取 cookie 概览
      try {
        await cdp.send('Network.enable');
        const ck = await cdp.send('Network.getAllCookies');
        const domains = ['douyin', 'kuaishou', 'bilibili', 'xiaohongshu', 'google', 'tiktok', 'weixin'];
        const hits = {};
        for (const c of ck.cookies || []) {
          for (const d of domains) {
            if (String(c.domain).indexOf(d) >= 0) {
              hits[d] = (hits[d] || 0) + 1;
            }
          }
        }
        info.cookieCounts = hits;
        const sess = (ck.cookies || []).find((c) => /^(SESSDATA|sessionid|sid_tt|sessionid_ss)$/.test(c.name));
        if (sess) info.hasSessionCookie = sess.name;
      } catch (e) {}
      cdp.close();
    } catch (err) {
      info.error = err.message;
    }
    out.push(info);
  }
  console.log(JSON.stringify(out, null, 2));
}

main().catch((e) => {
  console.error('DIAG_FAILED:', e.message);
  process.exit(1);
});
