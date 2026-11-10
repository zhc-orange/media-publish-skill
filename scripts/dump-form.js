'use strict';

/**
 * 按 URL 片段找到已打开的标签页，导出它的表单结构（输入框/可编辑区/按钮）。
 * 只读。用法：node dump-form.js <port> <urlSubstring>
 */

const http = require('node:http');

const PORT = Number(process.argv[2] || 9341);
const MATCH = String(process.argv[3] || '');

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

const DUMP = `(function(){
  var vis = function(el){
    if (!el || !el.isConnected) return false;
    var r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    var cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none';
  };
  var fields = [];
  document.querySelectorAll('input,textarea,[contenteditable=true]').forEach(function(el){
    if (!vis(el) || fields.length >= 14) return;
    fields.push({
      tag: el.tagName.toLowerCase(),
      type: el.getAttribute('type') || '',
      ph: (el.getAttribute('placeholder') || '').slice(0, 30),
      aria: (el.getAttribute('aria-label') || '').slice(0, 24),
      cls: String(el.className || '').slice(0, 44),
      editable: !!(el.isContentEditable || el.getAttribute('contenteditable') === 'true'),
      val: String(el.value || el.innerText || '').replace(/\\s+/g,' ').slice(0, 24)
    });
  });
  var btns = [];
  document.querySelectorAll('button,[role=button],div[class*=btn],span[class*=btn]').forEach(function(el){
    if (!vis(el) || btns.length >= 20) return;
    var t = (el.innerText || '').replace(/\\s+/g,' ').trim();
    if (!t || t.length > 14) return;
    if (btns.indexOf(t) < 0) btns.push(t);
  });
  var body = document.body ? document.body.innerText : '';
  return {
    url: location.href,
    fields: fields,
    buttons: btns,
    head: body.replace(/\\s+/g,' ').slice(0, 160),
    uploadSignals: (body.match(/(上传中|正在上传|上传完成|转码中|处理中|\\d{1,3}%)/g) || []).slice(0, 8)
  };
})()`;

(async () => {
  const list = await getJson(`http://127.0.0.1:${PORT}/json/list`);
  const page = list.find((t) => t.type === 'page' && t.url.indexOf(MATCH) >= 0);
  if (!page) {
    console.error(`没找到包含「${MATCH}」的标签页`);
    process.exit(1);
  }
  const cdp = new Cdp(page.webSocketDebuggerUrl);
  await cdp.connect();
  const res = await cdp.send('Runtime.evaluate', { expression: DUMP, returnByValue: true });
  const data = res && res.result ? res.result.value : null;
  try {
    const fs = require('node:fs');
    const os = require('node:os');
    const path = require('node:path');
    await cdp.send('Page.enable').catch(() => {});
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const dir = path.join(os.tmpdir(), 'media-publish');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `dump-${String(MATCH).replace(/[^\w]/g, '')}.png`);
    fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
    if (data) data.screenshot = file;
  } catch (e) {
    /* 截图失败不影响主流程 */
  }
  console.log(JSON.stringify(data, null, 2));
  cdp.close();
})().catch((e) => {
  console.error('DUMP_FAILED:', e.message);
  process.exit(1);
});
