'use strict';

/**
 * 平台侦察：打开各平台创作中心，导出「是否已登录 + 页面结构」。
 * 只读，不上传、不填写、不点发布。
 *
 * 用法：node scout.js [platformId ...]
 *   node scout.js                # 全部
 *   node scout.js douyin kuaishou
 */

const { spawn } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Chrome 候选路径（不同机器 / Edge 兜底），不再写死单一绝对路径
const CHROME_CANDIDATES = [
  path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
];
const CHROME = CHROME_CANDIDATES.find((p) => p && fs.existsSync(p)) || '';
// 独立 profile（和用户日常 Chrome 完全隔离）
const LINK = path.join(process.env.LOCALAPPDATA || '', 'media-publish-profile');
const PORT = Number(process.env.SCOUT_PORT || 9340);
const OUT = path.join(os.tmpdir(), 'media-publish-scout');

const PLATFORMS = {
  douyin: 'https://creator.douyin.com/creator-micro/content/upload',
  kuaishou: 'https://cp.kuaishou.com/article/publish/video',
  bilibili: 'https://member.bilibili.com/platform/upload/video/frame',
  xiaohongshu: 'https://creator.xiaohongshu.com/publish/publish?source=official',
  youtube: 'https://studio.youtube.com',
  tiktok: 'https://www.tiktok.com/tiktokstudio/upload?from=upload',
  wechat: 'https://channels.weixin.qq.com/platform/post/create',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.error('[scout]', ...a);

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
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.seq = 0;
    this.pending = new Map();
  }
  async connect() {
    this.ws = new WebSocket(this.wsUrl);
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('ws timeout')), 15000);
      this.ws.addEventListener('open', () => {
        clearTimeout(t);
        resolve();
      });
      this.ws.addEventListener('error', (e) => {
        clearTimeout(t);
        reject(new Error('ws error'));
      });
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
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`timeout ${method}`));
        }
      }, 60000);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  close() {
    try {
      this.ws.close();
    } catch (e) {
      /* ignore */
    }
  }
}

async function ensureChrome() {
  try {
    const v = await getJson(`http://127.0.0.1:${PORT}/json/version`);
    return v.webSocketDebuggerUrl;
  } catch (e) {
    /* launch */
  }
  // 只用独立 profile。绝不再联接 %LOCALAPPDATA%\Google\Chrome\User Data ——
  // 并发实例会重写那里的 Local State，导致用户的 Google 账号被登出。
  fs.mkdirSync(LINK, { recursive: true });
  spawn(
    CHROME,
    [
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${LINK}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-features=Translate',
      '--window-size=1440,1000',
      'about:blank',
    ],
    { stdio: 'ignore', detached: true, windowsHide: false }
  ).unref();
  for (let i = 0; i < 60; i += 1) {
    await sleep(500);
    try {
      const v = await getJson(`http://127.0.0.1:${PORT}/json/version`);
      if (v.webSocketDebuggerUrl) return v.webSocketDebuggerUrl;
    } catch (e) {
      /* retry */
    }
  }
  throw new Error('Chrome 未就绪');
}

async function openPage(browser, url) {
  const { targetId } = await browser.send('Target.createTarget', { url });
  for (let i = 0; i < 40; i += 1) {
    const list = await getJson(`http://127.0.0.1:${PORT}/json/list`).catch(() => []);
    const t = (list || []).find((x) => x.id === targetId);
    if (t && t.webSocketDebuggerUrl) {
      const page = new Cdp(t.webSocketDebuggerUrl);
      await page.connect();
      await page.send('Page.enable');
      return { page, targetId };
    }
    await sleep(300);
  }
  throw new Error('找不到页面 WS');
}

const PROBE = `(function(){
  var norm = function(s){ return String(s==null?'':s).replace(/\\s+/g,' ').trim(); };
  var vis = function(el){
    if(!el||!el.isConnected) return false;
    var r=el.getBoundingClientRect();
    if(r.width<2||r.height<2) return false;
    var cs=getComputedStyle(el);
    return cs.visibility!=='hidden'&&cs.display!=='none';
  };
  var files=[];
  document.querySelectorAll('input[type=file]').forEach(function(el){
    files.push({accept:(el.getAttribute('accept')||'').slice(0,40), visible:vis(el)});
  });
  var fields=[];
  document.querySelectorAll('input,textarea,[contenteditable=true]').forEach(function(el){
    if(fields.length>=12||!vis(el)) return;
    fields.push({tag:el.tagName.toLowerCase(),type:el.getAttribute('type')||'',
      ph:(el.getAttribute('placeholder')||'').slice(0,24),cls:String(el.className||'').slice(0,36)});
  });
  var btns=[];
  document.querySelectorAll('button,[role=button],div[class*=btn],span[class*=btn]').forEach(function(el){
    var t=norm(el.innerText||el.textContent);
    if(!t||t.length>12||btns.length>=18||!vis(el)) return;
    if(btns.indexOf(t)<0) btns.push(t);
  });
  var body = document.body ? document.body.innerText : '';
  return {
    url: location.href,
    title: document.title,
    bodyHead: norm(body).slice(0,260),
    needLogin: /扫码登录|密码登录|手机号登录|短信登录|Sign in|Log in|登录后/.test(body),
    fileInputs: files,
    fields: fields,
    buttons: btns
  };
})()`;

async function probe(page) {
  const res = await page.send('Runtime.evaluate', { expression: PROBE, returnByValue: true, awaitPromise: true });
  if (res && res.exceptionDetails) return { error: res.exceptionDetails.text };
  return res && res.result ? res.result.value : {};
}

async function main() {
  const wanted = process.argv.slice(2).filter((a) => PLATFORMS[a]);
  const ids = wanted.length ? wanted : Object.keys(PLATFORMS);
  if (fs.existsSync(LINK)) {
    log('检测到上次的 profile 链接，Chrome 需先退出；若报错请手动关闭 Chrome');
  }
  fs.mkdirSync(OUT, { recursive: true });
  const wsUrl = await ensureChrome();
  const browser = new Cdp(wsUrl);
  await browser.connect();

  const report = {};
  for (const id of ids) {
    const url = PLATFORMS[id];
    log(`打开 ${id} → ${url}`);
    let page = null;
    try {
      const opened = await openPage(browser, url);
      page = opened.page;
      await sleep(9000);
      // 首次启动可能被踢到登录页，回访一次
      let st = await probe(page);
      if (st && st.needLogin) {
        log(`${id} 落在登录/未登录页，重新打开一次`);
        await page.send('Page.navigate', { url });
        await sleep(8000);
        st = await probe(page);
      }
      const shot = await page.send('Page.captureScreenshot', { format: 'png' }).catch(() => null);
      let shotFile = '';
      if (shot) {
        shotFile = path.join(OUT, `${id}.png`);
        fs.writeFileSync(shotFile, Buffer.from(shot.data, 'base64'));
      }
      report[id] = { entry: url, screenshot: shotFile, ...st };
    } catch (err) {
      report[id] = { entry: url, error: err.message };
    } finally {
      if (page) page.close();
    }
  }

  const file = path.join(OUT, 'report.json');
  fs.writeFileSync(file, JSON.stringify(report, null, 2), 'utf8');
  browser.close();
  console.log(JSON.stringify({ report: file, platforms: report }, null, 2));
}

main().catch((e) => {
  console.error('SCOUT_FAILED:', e.message);
  process.exit(1);
});
