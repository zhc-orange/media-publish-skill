'use strict';

/**
 * 多平台自媒体「只填不发」投放器。
 *
 * 对每个平台：打开创作中心 → 上传视频 → 填标题/简介/话题 →（必要项：创作声明、封面）
 * 然后停在发布前，把所有标签页保留在已注入完成的状态，等你自己点发布。
 *
 * 本脚本**没有任何点击发布的代码**，这是刻意的。
 *
 * 用法：
 *   node publish.js --video <mp4> --title <标题> [--desc <简介>] [--tags a,b] [--platforms douyin,bilibili]
 *   node publish.js --check                 # 只检测各平台登录态
 */

const { spawn } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PLATFORMS, getPlatform } = require('./platforms');

/* ------------------------------ 参数 ------------------------------ */

function parseArgs(argv) {
  const out = {
    video: '',
    title: '',
    desc: '',
    tags: '',
    cover: '',
    platforms: '',
    check: false,
    port: 9341,
    profile: '',
    timeoutSec: 900,
    loginWaitSec: 300,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => {
      i += 1;
      return argv[i];
    };
    if (a === '--video') out.video = next();
    else if (a === '--title') out.title = next();
    else if (a === '--desc') out.desc = next();
    else if (a === '--tags') out.tags = next();
    else if (a === '--cover') out.cover = next();
    else if (a === '--platforms') out.platforms = next();
    else if (a === '--check') out.check = true;
    else if (a === '--port') out.port = Number(next());
    else if (a === '--profile') out.profile = next();
    else if (a === '--timeout') out.timeoutSec = Number(next());
    else if (a === '--login-wait') out.loginWaitSec = Number(next());
    else if (a === '--discard-leftover') out.discardLeftover = true;
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));

const CHROME_CANDIDATES = [
  path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
];

// 独立 profile：和用户日常 Chrome 完全隔离，可并行运行。
// 千万不要改回 %LOCALAPPDATA%\Google\Chrome\User Data —— 那会冲掉用户的 Google 账号登录态。
const DEFAULT_PROFILE = path.join(process.env.LOCALAPPDATA || '', 'media-publish-profile');
const OUT_DIR = path.join(os.tmpdir(), 'media-publish');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.error('[publish]', ...a);

/* ------------------------------ 基础 ------------------------------ */

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
    this.waiters = [];
  }

  async connect() {
    if (typeof WebSocket === 'undefined') throw new Error('需要 Node 22+（内置 WebSocket）');
    this.ws = new WebSocket(this.wsUrl, { maxPayload: 512 * 1024 * 1024 });
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('WebSocket 连接超时')), 15000);
      this.ws.addEventListener('open', () => {
        clearTimeout(t);
        resolve();
      });
      this.ws.addEventListener('error', () => {
        clearTimeout(t);
        reject(new Error('WebSocket 连接失败'));
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
        return;
      }
      if (m.method) {
        for (const w of this.waiters.slice()) if (w.method === m.method) w.resolve(m);
      }
    });
  }

  waitEvent(method, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w.resolve !== onHit);
        reject(new Error(`等待事件超时：${method}`));
      }, timeoutMs);
      const onHit = (m) => {
        clearTimeout(timer);
        this.waiters = this.waiters.filter((w) => w.resolve !== onHit);
        resolve(m);
      };
      this.waiters.push({ method, resolve: onHit });
    });
  }

  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.seq;
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP 超时：${method}`));
        }
      }, 90000);
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

/* --------------------------- 页面内工具 --------------------------- */

const HELPERS = `
window.__mAll = function(root, sel, out){
  out = out || []; root = root || document;
  try { var l = root.querySelectorAll(sel); for (var i=0;i<l.length;i++) out.push(l[i]); } catch(e){}
  var all = root.querySelectorAll ? root.querySelectorAll('*') : [];
  for (var j=0;j<all.length;j++){ if (all[j].shadowRoot) window.__mAll(all[j].shadowRoot, sel, out); }
  return out;
};
window.__mDeep = function(sel){ var a = window.__mAll(document, sel, []); return a.length ? a[0] : null; };
window.__mVisible = function(el){
  if (!el || !el.isConnected) return false;
  var r = el.getBoundingClientRect();
  if (r.width < 2 || r.height < 2) return false;
  var cs = getComputedStyle(el);
  return cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) !== 0;
};
window.__mText = function(el){ return (el.innerText || el.textContent || '').replace(/\\s+/g,' ').trim(); };
window.__mLabel = function(el){
  return (el.getAttribute && (el.getAttribute('aria-label') || el.getAttribute('title') || '')) || '';
};
window.__mByText = function(needle){
  var scope = window.__mAll(document, 'button,a,[role=button],label,span,div,li,ytcp-button', []);
  var best = null;
  for (var i=0;i<scope.length;i++){
    var el = scope[i];
    var t = window.__mText(el);
    var label = window.__mLabel(el);
    var hay = (t + ' ' + label).trim();
    if (!hay || hay.length > 40 || hay.indexOf(needle) < 0) continue;
    if (!window.__mVisible(el)) continue;
    var score = t ? t.length : label.length + 2; // 有文字的优先
    if (!best || score < best.len) best = { el: el, len: score };
  }
  return best ? best.el : null;
};
window.__mMark = function(el){
  if (!el) return { ok: false };
  try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch(e){}
  var r = el.getBoundingClientRect();
  return { ok: true, tag: el.tagName.toLowerCase(), text: window.__mText(el).slice(0,40),
           rect: { x: r.left, y: r.top, w: r.width, h: r.height } };
};
window.__mFindField = function(selectors, placeholderRe){
  var list = selectors || [];
  for (var i = 0; i < list.length; i++) {
    var els = window.__mAll(document, list[i], []);
    for (var j = 0; j < els.length; j++) { if (window.__mVisible(els[j])) return els[j]; }
  }
  if (placeholderRe) {
    var re = new RegExp(placeholderRe);
    var cands = window.__mAll(document, 'input,textarea,[contenteditable=true]', []);
    for (var k = 0; k < cands.length; k++) {
      var el = cands[k];
      if (!window.__mVisible(el)) continue;
      var ph = (el.getAttribute('placeholder') || '') + ' ' + (el.getAttribute('aria-label') || '') + ' ' + (el.getAttribute('data-placeholder') || '');
      if (re.test(ph)) return el;
    }
  }
  return null;
};
`;

async function evalJs(cdp, expr) {
  const res = await cdp.send('Runtime.evaluate', {
    expression: `(function(){ ${HELPERS}; return (${expr}); })()`,
    returnByValue: true,
    awaitPromise: true,
    userGesture: true,
  });
  if (res && res.exceptionDetails) {
    const d = res.exceptionDetails;
    throw new Error((d.exception && d.exception.description) || d.text || '页面脚本执行失败');
  }
  return res && res.result ? res.result.value : undefined;
}

async function clickAt(cdp, x, y) {
  const px = Math.round(x);
  const py = Math.round(y);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: px, y: py, button: 'none' });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: px, y: py, button: 'left', buttons: 1, clickCount: 1 });
  await sleep(40);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: px, y: py, button: 'left', buttons: 0, clickCount: 1 });
}

async function clickText(cdp, text) {
  const mark = await evalJs(cdp, `(function(){ return window.__mMark(window.__mByText(${JSON.stringify(text)})); })()`);
  if (!mark || !mark.ok) return null;
  await clickAt(cdp, mark.rect.x + mark.rect.w / 2, mark.rect.y + mark.rect.h / 2);
  await sleep(400);
  return mark;
}

async function pressKey(cdp, key) {
  const map = { Escape: 27, Enter: 13, Tab: 9 };
  const vk = map[key] || 0;
  await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key, code: key, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
  await sleep(150);
}

async function selectAll(cdp) {
  for (const type of ['keyDown', 'keyUp']) {
    await cdp.send('Input.dispatchKeyEvent', { type, key: 'a', code: 'KeyA', modifiers: 2, windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65 });
  }
  await sleep(80);
}

async function screenshot(cdp, name) {
  try {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const file = path.join(OUT_DIR, `${name}.png`);
    fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
    return file;
  } catch (e) {
    return '';
  }
}

/* ------------------------ 字段填写（通用） ------------------------ */

async function fillField(cdp, selectorList, placeholderRe, value, label) {
  if (!value) return { skipped: true };
  const picked = await evalJs(
    cdp,
    `(function(){
      var el = window.__mFindField(${JSON.stringify(selectorList || [])}, ${JSON.stringify(placeholderRe ? placeholderRe.source : null)});
      if (!el) return { ok: false };
      var editable = el.isContentEditable || el.getAttribute('contenteditable') === 'true';
      var m = window.__mMark(el);
      return { ok: true, editable: editable, tag: el.tagName.toLowerCase(), rect: m.rect };
    })()`
  );
  if (!picked || !picked.ok) return { ok: false, reason: 'not_found' };

  if (!picked.editable) {
    const set = await evalJs(
      cdp,
      `(function(){
        var el = window.__mFindField(${JSON.stringify(selectorList || [])}, ${JSON.stringify(placeholderRe ? placeholderRe.source : null)});
        if (!el) return { ok: false };
        el.focus();
        var proto = el.tagName.toLowerCase() === 'textarea' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        var desc = Object.getOwnPropertyDescriptor(proto, 'value');
        desc.set.call(el, ${JSON.stringify(value)});
        el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return { ok: true, value: el.value };
      })()`
    );
    if (set && set.ok && String(set.value).trim() === String(value).trim()) {
      log(`  ${label}：已填写（input）`);
      return { ok: true, mode: 'input' };
    }
  }

  // contenteditable 或赋值失败：先用 JS 聚焦/全选，再走输入通道（不依赖坐标，最稳）
  const focused = await evalJs(
    cdp,
    `(function(){
      var el = window.__mFindField(${JSON.stringify(selectorList || [])}, ${JSON.stringify(placeholderRe ? placeholderRe.source : null)});
      if (!el) return { ok: false };
      try { el.focus(); } catch (e) {}
      var editable = el.isContentEditable || el.getAttribute('contenteditable') === 'true';
      if (editable) {
        var r = document.createRange();
        r.selectNodeContents(el);
        var s = window.getSelection();
        s.removeAllRanges();
        s.addRange(r);
      } else if (el.select) {
        el.select();
      }
      return { ok: document.activeElement === el || editable, editable: editable };
    })()`
  );
  if (!focused || !focused.ok) {
    // 聚焦失败才退回坐标点击
    await clickAt(cdp, picked.rect.x + Math.min(picked.rect.w / 2, 40), picked.rect.y + picked.rect.h / 2);
    await sleep(200);
    await selectAll(cdp);
  }
  await sleep(150);
  await cdp.send('Input.insertText', { text: String(value) });
  await sleep(450);

  const got = await evalJs(
    cdp,
    `(function(){
      var el = window.__mFindField(${JSON.stringify(selectorList || [])}, ${JSON.stringify(placeholderRe ? placeholderRe.source : null)});
      if (!el) return '';
      return (el.isContentEditable ? (el.innerText || '') : (el.value || '')).trim();
    })()`
  );
  const ok = String(got).includes(String(value).trim().slice(0, 8));
  log(`  ${label}：${ok ? '已填写（键盘）' : `回读异常「${String(got).slice(0, 30)}」`}`);
  return { ok, mode: 'keyboard', readback: got };
}

/* ---------------------------- 话题标签 ---------------------------- */

async function appendInlineTags(cdp, cfg, tags) {
  const text = tags.map((t) => `${cfg.tags.prefix || '#'}${t}`).join(' ');
  const sel = cfg.descSelectors && cfg.descSelectors.length ? cfg.descSelectors : cfg.titleSelectors;
  const picked = await evalJs(
    cdp,
    `(function(){
      var el = window.__mFindField(${JSON.stringify(sel || [])}, ${JSON.stringify(cfg.descPlaceholder ? cfg.descPlaceholder.source : null)});
      if (!el) return { ok: false };
      var m = window.__mMark(el);
      return { ok: true, rect: m.rect, editable: el.isContentEditable || el.getAttribute('contenteditable') === 'true' };
    })()`
  );
  if (!picked || !picked.ok) return { ok: false, reason: 'no_desc_field' };
  await clickAt(cdp, picked.rect.x + Math.min(picked.rect.w / 2, 40), picked.rect.y + picked.rect.h / 2);
  await sleep(150);
  // 光标移到末尾
  await evalJs(
    cdp,
    `(function(){
      var el = window.__mFindField(${JSON.stringify(sel || [])}, null);
      if (!el) return 0;
      if (el.isContentEditable) {
        el.focus();
        var r = document.createRange(); r.selectNodeContents(el); r.collapse(false);
        var s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
      }
      return 1;
    })()`
  );
  await cdp.send('Input.insertText', { text: ` ${text}` });
  await sleep(400);
  log(`  话题：已在正文末尾追加 ${text}`);
  return { ok: true, mode: 'inline' };
}

async function chipTags(cdp, cfg, tags) {
  const selector = cfg.tags.selector || 'input[placeholder*="标签"]';

  // YouTube 的话题框在「显示更多」折叠区里，先展开
  for (const b of cfg.tags.openButtons || []) {
    const label = b.startsWith('text=') ? b.slice(5) : b;
    const clicked = await clickText(cdp, label);
    if (clicked) {
      log(`  展开「${label}」`);
      await sleep(1500);
    }
  }

  const listExpr = `(function(){
    var input = window.__mFindField([${JSON.stringify(selector)}], null);
    if (!input) return { ok: false, chips: [] };
    var scope = input.closest('div') ? input.closest('div').parentElement : input.parentElement;
    var out = {}, els = scope ? scope.querySelectorAll('*') : [];
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      if (el === input || el.contains(input)) continue;
      var t = (el.innerText || '').replace(/\\s+/g, '').trim();
      if (!t || t.length > 12 || /还可以添加|创建标签|添加标签|Add/.test(t)) continue;
      var r = el.getBoundingClientRect();
      if (r.width < 24 || r.width > 240 || r.height < 16 || r.height > 44) continue;
      if (!out[t] || r.width > out[t].w) out[t] = { text: t, x: r.x, y: r.y, w: r.width, h: r.height };
    }
    return { ok: true, chips: Object.keys(out).map(function (k) { return out[k]; }) };
  })()`;

  const current = await evalJs(cdp, listExpr);
  if (!current.ok) return { ok: false, reason: 'no_tag_input' };

  if (cfg.tags.replace) {
    const keep = new Set(tags);
    const removals = current.chips.filter((c) => !keep.has(c.text)).sort((a, b) => b.x - a.x);
    for (const chip of removals) {
      const fresh = await evalJs(cdp, listExpr);
      const hit = (fresh.chips || []).find((c) => c.text === chip.text);
      if (!hit) continue;
      await clickAt(cdp, hit.x + hit.w - 9, hit.y + hit.h / 2);
      await sleep(400);
      log(`  移除平台默认标签：${chip.text}`);
    }
  }

  const after = await evalJs(cdp, listExpr);
  const existing = new Set((after.chips || []).map((c) => c.text));
  for (const tag of tags) {
    if (existing.has(tag)) continue;
    const mark = await evalJs(
      cdp,
      `(function(){ var el = window.__mFindField([${JSON.stringify(selector)}], null); return window.__mMark(el); })()`
    );
    if (!mark || !mark.ok) return { ok: false, reason: 'tag_input_lost' };
    await clickAt(cdp, mark.rect.x + Math.min(mark.rect.w / 2, 40), mark.rect.y + mark.rect.h / 2);
    await sleep(200);
    await cdp.send('Input.insertText', { text: tag });
    await sleep(350);
    await pressKey(cdp, 'Enter');
    await sleep(650);
    log(`  新增标签：${tag}`);
  }
  const final = await evalJs(cdp, listExpr);
  const found = (final.chips || []).map((c) => c.text);
  return { ok: true, mode: 'chip', tags: found.length ? found : tags };
}

/* ------------------------- 平台必要项（B 站） ------------------------- */

async function bilibiliDeclaration(cdp) {
  const readValue = async () =>
    evalJs(cdp, `(function(){ var el = window.__mDeep('input.bcc-select-input-inner'); return el ? el.value : ''; })()`);

  // 创作声明是异步渲染的，先等控件出现（最多 15 秒）
  let mark = null;
  for (let i = 0; i < 15; i += 1) {
    mark = await evalJs(cdp, `(function(){ return window.__mMark(window.__mDeep('input.bcc-select-input-inner')); })()`);
    if (mark && mark.ok) break;
    await sleep(1000);
  }
  if (!mark || !mark.ok) {
    log('  创作声明：控件未出现，需人工选');
    return { ok: false, value: '' };
  }
  if (await readValue()) {
    log(`  创作声明：${await readValue()}`);
    return { ok: true, value: await readValue() };
  }
  await clickAt(cdp, mark.rect.x + mark.rect.w / 2, mark.rect.y + mark.rect.h / 2);
  await sleep(800);

  // 选项一直在 DOM 里，必须挑「当前真正可见」的那个
  const pick = async (label) =>
    evalJs(
      cdp,
      `(function(){
        var opts = window.__mAll(document, '.bcc-option', []);
        for (var i = 0; i < opts.length; i++) {
          var el = opts[i];
          var t = (el.innerText || '').trim();
          if (t.indexOf(${JSON.stringify(label)}) < 0) continue;
          var r = el.getBoundingClientRect();
          if (r.width < 10 || r.height < 8) continue;
          return { ok: true, x: r.x, y: r.y, w: r.width, h: r.height };
        }
        return { ok: false, total: opts.length };
      })()`
    );

  // 点开下拉后，选项要等一会才可见；点不到就再点一次（偶尔会被浮层吃掉第一下）
  let opt = null;
  for (let round = 0; round < 2 && !(opt && opt.ok); round += 1) {
    if (round > 0) {
      await clickAt(cdp, mark.rect.x + mark.rect.w / 2, mark.rect.y + mark.rect.h / 2);
    }
    for (let i = 0; i < 8; i += 1) {
      await sleep(700);
      opt = await pick('内容无需标注');
      if (opt && opt.ok) break;
    }
  }

  if (opt && opt.ok) {
    await clickAt(cdp, opt.x + opt.w / 2, opt.y + opt.h / 2);
    await sleep(700);
    const value = await readValue();
    if (value) {
      log(`  创作声明：${value}`);
      return { ok: true, value };
    }
  }

  // 兜底：试「内容为自制」
  const self = await pick('内容为自制');
  if (self && self.ok) {
    await clickAt(cdp, self.x + self.w / 2, self.y + self.h / 2);
    await sleep(700);
    const value = await readValue();
    if (value) {
      log(`  创作声明：${value}`);
      return { ok: true, value };
    }
  }

  // 没选上就关掉下拉，避免挡住后面的操作
  await pressKey(cdp, 'Escape');
  log('  创作声明：未选上（需人工选，B 站是必填项）');
  return { ok: false, value: '' };
}

async function bilibiliCover(cdp) {
  // 推荐封面要等平台抽帧，轮询最多 20 秒
  let mark = null;
  for (let i = 0; i < 20; i += 1) {
    mark = await evalJs(
      cdp,
      `(function(){
        var items = window.__mAll(document, '[class*="img-item"]', []);
        for (var j = 0; j < items.length; j++) {
          var el = items[j];
          var bg = getComputedStyle(el).backgroundImage || '';
          if (bg.indexOf('url(') < 0) continue;
          try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch (e) {}
          var r = el.getBoundingClientRect();
          if (r.width < 60 || r.width > 260 || r.height < 40) continue;
          return { ok: true, x: r.x, y: r.y, w: r.width, h: r.height };
        }
        return { ok: false };
      })()`
    );
    if (mark && mark.ok) break;
    await sleep(1000);
  }
  if (!mark || !mark.ok) {
    log('  封面：20 秒内没等到推荐帧，保留平台默认');
    return { ok: false, reason: 'no_thumb' };
  }
  await clickAt(cdp, mark.x + mark.w / 2, mark.y + mark.h / 2);
  await sleep(1400);
  const stillEmpty = await evalJs(cdp, `(function(){ return !!window.__mDeep('.cover-empty'); })()`);
  log(`  封面：${stillEmpty ? '未生效（需人工）' : '已使用视频推荐帧'}`);
  return { ok: !stillEmpty };
}

/* ---------------------------- Chrome ---------------------------- */

function resolveChrome() {
  for (const p of CHROME_CANDIDATES) {
    try {
      if (p && fs.existsSync(p)) return p;
    } catch (e) {
      /* ignore */
    }
  }
  return '';
}

async function launchChrome(profileDir, port) {
  // 硬保险：任何指向真实 Chrome 配置目录的 profile 一律拒绝启动。
  // 历史事故：第二个实例会重写 Local State，把用户的 Google 账号登出。
  const resolved = path.resolve(String(profileDir || '')).toLowerCase().replace(/\//g, '\\');
  if (resolved.includes('google\\chrome\\user data')) {
    throw new Error(
      `拒绝启动：profile 指向真实 Chrome 配置目录（${profileDir}）。\n` +
        '第二个 Chrome 实例会重写 Local State，导致 Google 账号被登出。\n' +
        '请改用独立 profile（默认 %LOCALAPPDATA%\\media-publish-profile）。'
    );
  }
  const browser = resolveChrome();
  if (!browser) throw new Error('未找到 Chrome/Edge');
  log(`启动 Chrome：${browser}`);
  spawn(
    browser,
    [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profileDir}`,
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
      const v = await getJson(`http://127.0.0.1:${port}/json/version`);
      if (v.webSocketDebuggerUrl) return v.webSocketDebuggerUrl;
    } catch (e) {
      /* retry */
    }
  }
  throw new Error('Chrome 调试端口未就绪');
}

async function openTab(browser, port, url, reuse) {
  // --check 复用已打开的同域标签页；正式填写一律开新标签页，
  // 因为旧标签页里可能残留上一次的填写状态，会误导判断。
  let host = '';
  try {
    host = new URL(url).hostname;
  } catch (e) {
    /* ignore */
  }
  if (reuse && host) {
    const list = await getJson(`http://127.0.0.1:${port}/json/list`).catch(() => []);
    const existing = (list || []).find((t) => {
      if (t.type !== 'page') return false;
      try {
        return new URL(t.url).hostname === host;
      } catch (e) {
        return false;
      }
    });
    if (existing && existing.webSocketDebuggerUrl) {
      const page = new Cdp(existing.webSocketDebuggerUrl);
      await page.connect();
      await page.send('Page.enable');
      await page.send('DOM.enable');
      log(`  复用已打开的标签页：${String(existing.url).slice(0, 60)}`);
      return { page, targetId: existing.id, reused: true };
    }
  }

  const { targetId } = await browser.send('Target.createTarget', { url });
  for (let i = 0; i < 40; i += 1) {
    const list = await getJson(`http://127.0.0.1:${port}/json/list`).catch(() => []);
    const t = (list || []).find((x) => x.id === targetId);
    if (t && t.webSocketDebuggerUrl) {
      const page = new Cdp(t.webSocketDebuggerUrl);
      await page.connect();
      await page.send('Page.enable');
      await page.send('DOM.enable');
      return { page, targetId };
    }
    await sleep(300);
  }
  throw new Error('找不到标签页调试地址');
}

/* ---------------------------- 登录判定 ---------------------------- */

// 登录页特征（URL 级，最可靠）
const LOGIN_URL_RE = /passport\.bilibili|accounts\.google|\/login|login\.html|\/signin/i;

// 正向信号：这些元素只在「已登录的创作页」才存在。
// 注意：绝不能用正文里出现「扫码登录」来判断未登录 —— 很多平台的创作页里就带着隐藏的登录弹窗文案。
const POSITIVE_SELECTORS = [
  'input[type=file]',
  '[class*=avatar]',
  '[class*=user-info]',
  '[class*=userInfo]',
  'ytcp-avatar',
  '#avatar-btn',
  '[data-e2e="profile-icon"]',
];

async function probeState(page, cfg) {
  const extra = JSON.stringify([...(cfg.loggedInSelectors || [])]);
  const generic = JSON.stringify(POSITIVE_SELECTORS);
  return evalJs(
    page,
    `(function(){
      var sels = ${generic}.concat(${extra});
      var hits = 0;
      for (var i = 0; i < sels.length; i++) {
        try { if (window.__mAll(document, sels[i], []).length > 0) hits++; } catch (e) {}
      }
      return {
        url: location.href,
        hasFileInput: window.__mAll(document, 'input[type=file]', []).length > 0,
        positives: hits
      };
    })()`
  ).catch(() => ({ url: '', hasFileInput: false, positives: 0 }));
}

function judge(cfg, st) {
  if (LOGIN_URL_RE.test(String(st.url || ''))) return 'login';
  if (st.hasFileInput || st.positives > 0) return 'in';
  if (cfg.loginUrlIncludes && String(st.url || '').indexOf(cfg.loginUrlIncludes) < 0) return 'login';
  return 'unknown'; // 页面还在渲染，或结构变了
}

async function ensureLoggedIn(page, cfg, waitMs) {
  // 阶段一：重开几次，排除「Chrome 首次启动 cookie 尚未生效」导致的假未登录
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const st = await probeState(page, cfg);
    const verdict = judge(cfg, st);
    if (verdict === 'in') return { ok: true, url: st.url };
    if (attempt < 3) {
      log(`  判定=${verdict}（${String(st.url).slice(0, 70)}），第 ${attempt + 1} 次重开`);
      await page.send('Page.navigate', { url: cfg.entry }).catch(() => {});
      await sleep(4500);
    }
  }

  // 阶段二：确实未登录 —— 停在登录页，安静等人工扫码
  if (!waitMs || waitMs <= 0) {
    await page.send('Page.navigate', { url: cfg.loginUrl }).catch(() => {});
    await sleep(1200);
    return { ok: false };
  }

  log(`  需要登录：已停在登录页，等你扫码（最多 ${Math.round(waitMs / 1000)} 秒，期间不会动这个标签页）`);
  await page.send('Page.navigate', { url: cfg.loginUrl }).catch(() => {});
  const deadline = Date.now() + waitMs;
  let lastNote = 0;
  while (Date.now() < deadline) {
    await sleep(3000);
    const st = await probeState(page, cfg);
    if (judge(cfg, st) === 'in') {
      log('  检测到登录完成，回到投稿页');
      await page.send('Page.navigate', { url: cfg.entry }).catch(() => {});
      await sleep(5000);
      const after = await probeState(page, cfg);
      if (judge(cfg, after) === 'in') return { ok: true, url: after.url, viaLogin: true };
      log('  登录后回到投稿页仍判定异常');
      return { ok: false };
    }
    if (Date.now() - lastNote > 15000) {
      lastNote = Date.now();
      log(`  仍在等登录…还剩 ${Math.max(0, Math.ceil((deadline - Date.now()) / 1000))} 秒`);
    }
  }
  return { ok: false, timeout: true };
}

/* ---------------------------- 单平台流程 ---------------------------- */

async function uploadVideo(page, cfg, entry, videoPath) {
  await page.send('Page.setInterceptFileChooserDialog', { enabled: true });
  let backendNodeId = 0;
  try {
    const waiting = page.waitEvent('Page.fileChooserOpened', 12000);
    let clicked = null;
    for (const btn of cfg.uploadButtons || []) {
      if (!btn.startsWith('text=')) continue;
      clicked = await clickText(page, btn.slice(5));
      if (clicked) break;
    }
    if (!clicked) {
      await waiting.catch(() => null);
      return { ok: false, reason: '找不到上传按钮' };
    }
    const ev = await waiting.catch(() => null);
    backendNodeId = ev && ev.params ? ev.params.backendNodeId : 0;
  } finally {
    await page.send('Page.setInterceptFileChooserDialog', { enabled: false }).catch(() => {});
  }

  if (backendNodeId) {
    await page.send('DOM.setFileInputFiles', { backendNodeId, files: [path.resolve(videoPath)] });
    log(`  已通过文件选择框注入视频`);
    return { ok: true, mode: 'chooser' };
  }

  // 兜底：直接把文件塞进页面里的第一个视频 input
  const picked = await page.send('Runtime.evaluate', {
    expression: `(function(){ ${HELPERS};
      var inputs = window.__mAll(document, 'input[type=file]', []);
      for (var i = 0; i < inputs.length; i++) {
        var acc = String(inputs[i].getAttribute('accept') || '').toLowerCase();
        if (acc.indexOf('.txt') >= 0) continue;
        return inputs[i];
      }
      return null;
    })()`,
    returnByValue: false,
  });
  const objectId = picked && picked.result && picked.result.objectId;
  if (!objectId) return { ok: false, reason: '页面没有可用的文件输入框' };
  await page.send('DOM.setFileInputFiles', { objectId, files: [path.resolve(videoPath)] });
  await page.send('Runtime.callFunctionOn', {
    objectId,
    functionDeclaration: `function(){
      this.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
      this.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
      return this.files ? this.files.length : 0;
    }`,
    returnByValue: true,
  });
  log('  已通过 DOM 直接注入视频（兜底路径）');
  return { ok: true, mode: 'direct' };
}

async function waitEditor(page, cfg) {
  // --timeout 可以整体收窄每个平台的等待预算，方便快速迭代校准
  const budget = Math.min(cfg.waitMs || 300000, (args.timeoutSec || 900) * 1000);
  const deadline = Date.now() + budget;
  let lastNote = 0;
  while (Date.now() < deadline) {
    const st = await evalJs(
      page,
      `(function(){
        var el = window.__mFindField(${JSON.stringify(cfg.titleSelectors || [])}, ${JSON.stringify(cfg.titlePlaceholder ? cfg.titlePlaceholder.source : null)});
        var body = document.body ? document.body.innerText : '';
        var pct = (body.match(/(\\d{1,3})\\s*%/) || [])[1] || '';
        return { ready: !!el, pct: pct, head: body.replace(/\\s+/g,' ').slice(0, 80) };
      })()`
    ).catch(() => ({ ready: false }));
    if (st.ready) return true;
    if (Date.now() - lastNote > 15000) {
      lastNote = Date.now();
      log(`  等待上传/转码… ${st.pct ? st.pct + '%' : st.head || ''}`.trim());
    }
    await sleep(2000);
  }
  return false;
}

async function runPlatform(browser, cfg, job) {
  const startedAt = Date.now();
  const result = { id: cfg.id, name: cfg.name, confidence: cfg.confidence, status: 'unknown', notes: [] };
  let page = null;
  try {
    const opened = await openTab(browser, args.port, cfg.entry, false);
    page = opened.page;
    await sleep(6000);

    const login = await ensureLoggedIn(page, cfg, (args.loginWaitSec || 0) * 1000);
    if (!login.ok) {
      result.status = 'need_login';
      result.url = cfg.loginUrl;
      result.notes.push('未登录：已把该标签页停在登录页，扫码登录后重跑该平台即可');
      log(`  ✗ 未登录，标签页停在登录页`);
      return result;
    }
    log(`  登录状态正常`);

    // 有些平台会弹「还有上次未发布的视频，是否继续编辑？」——它会挡住上传。
    // 默认不自动处理（那可能是一条真实的草稿）；加 --discard-leftover 才点「放弃」。
    if (cfg.leftoverPrompt) {
      // 这个提示常常比页面主体晚出现，轮询 10 秒
      let seen = false;
      for (let i = 0; i < 10 && !seen; i += 1) {
        seen = await evalJs(
          page,
          `(function(){ return (document.body?document.body.innerText:'').indexOf(${JSON.stringify(cfg.leftoverPrompt)}) >= 0; })()`
        ).catch(() => false);
        if (!seen) await sleep(800);
      }
      if (seen) {
        if (args.discardLeftover) {
          for (const t of cfg.leftoverDismiss || []) {
            const clicked = await clickText(page, t);
            if (clicked) {
              log(`  发现「${cfg.leftoverPrompt}」，已点「${t}」丢弃旧草稿`);
              await sleep(1500);
              break;
            }
          }
        } else {
          log(`  ⚠ 发现「${cfg.leftoverPrompt}」——它会挡住上传；加 --discard-leftover 可自动丢弃旧草稿，或手动处理后重跑`);
        }
      }
    }

    // 有些平台的上传入口藏在菜单里（YouTube 的「创建」是图标按钮），
    // 配置了 entryTemplate 就直接跳到上传弹窗
    if (cfg.entryTemplate) {
      const ch = await evalJs(page, `(function(){ var m = String(location.pathname).match(/\\/channel\\/(UC[\\w-]+)/); return m ? m[1] : ''; })()`).catch(() => '');
      if (ch) {
        const target = cfg.entryTemplate.replace('{channelId}', ch);
        log(`  直达上传弹窗：${target}`);
        await page.send('Page.navigate', { url: target }).catch(() => {});
        await sleep(8000);
      } else {
        log('  没取到 channelId，继续用普通入口');
      }
    }

    const up = await uploadVideo(page, cfg, cfg.entry, job.video);
    if (!up.ok) {
      result.status = 'failed';
      result.notes.push(`上传失败：${up.reason}`);
      return result;
    }

    if (!(await waitEditor(page, cfg))) {
      result.status = 'failed';
      result.notes.push('上传后没等到编辑表单');
      return result;
    }
    log('  编辑表单已就绪');

    const info = await evalJs(
      page,
      `(function(){
        var t = window.__mFindField(${JSON.stringify(cfg.titleSelectors || [])}, ${JSON.stringify(cfg.titlePlaceholder ? cfg.titlePlaceholder.source : null)});
        return { url: location.href, autoTitle: t ? (t.value || t.innerText || '').slice(0, 60) : '' };
      })()`
    ).catch(() => ({}));
    if (info && info.autoTitle) result.platformAutoTitle = info.autoTitle;

    const titleText = cfg.mergedTitleDesc && job.desc ? `${job.title}\n${job.desc}` : job.title;
    const titleRes = await fillField(page, cfg.titleSelectors, cfg.titlePlaceholder, titleText, '标题');
    result.titleFilled = !!titleRes.ok;

    if (!cfg.mergedTitleDesc && job.desc) {
      const descRes = await fillField(page, cfg.descSelectors, cfg.descPlaceholder, job.desc, '简介');
      result.descFilled = !!descRes.ok;
    }

    if (job.tags.length) {
      if (cfg.tags.mode === 'chip') {
        const tagRes = await chipTags(page, cfg, job.tags);
        result.tags = tagRes.tags || job.tags;
        result.tagsOk = !!tagRes.ok;
      } else {
        const tagRes = await appendInlineTags(page, cfg, job.tags);
        result.tags = job.tags;
        result.tagsOk = !!tagRes.ok;
      }
    }

    for (const extra of cfg.extras || []) {
      if (extra === 'declaration') {
        const d = await bilibiliDeclaration(page);
        result.declaration = d.value || '';
      } else if (extra === 'cover') {
        const c = await bilibiliCover(page);
        result.cover = c.ok ? 'recommended' : 'manual';
      }
    }

    // 有些平台是分步的（上传 → 下一步 → 发布设置页），推到能看到「发布」按钮的那一页再停
    for (const btn of cfg.advanceButtons || []) {
      const label = btn.startsWith('text=') ? btn.slice(5) : btn;
      const clicked = await clickText(page, label);
      if (clicked) {
        await sleep(2500);
        result.advanced = (result.advanced || []).concat(label);
        log(`  已点击「${label}」进入下一屏`);
      } else {
        log(`  未找到「${label}」按钮（可能已是最后一步）`);
      }
    }

    result.status = result.titleFilled ? 'ready' : 'partial';
    result.url = info ? info.url : cfg.entry;
    result.screenshot = await screenshot(page, `${cfg.id}-ready`);
    result.elapsedSec = Math.round((Date.now() - startedAt) / 1000);

    // 注意：到此为止。绝不点发布，标签页保持打开。
    log(`  ✓ 已填好，停在发布前（${result.elapsedSec}s）`);
    return result;
  } catch (err) {
    result.status = 'failed';
    result.notes.push(err.message);
    if (page) {
      result.screenshot = await screenshot(page, `${cfg.id}-error`);
      const st = await evalJs(page, `(function(){ return { url: location.href, body: (document.body?document.body.innerText:'').replace(/\\s+/g,' ').slice(0,200) }; })()`).catch(() => ({}));
      if (st && st.url) result.notes.push(`页面：${st.url}`);
      if (st && st.body) result.notes.push(st.body);
    }
    return result;
  } finally {
    // 关闭该页面的 CDP 连接，但**不关闭标签页**
    if (page) page.close();
  }
}

/* ------------------------------ 主流程 ------------------------------ */

function usage() {
  console.log(
    [
      '多平台自媒体「只填不发」投放器',
      '',
      '用法：node publish.js --video <mp4> --title <标题> [选项]',
      '',
      '  --desc <文本>        简介',
      '  --tags a,b           话题标签（逗号分隔，不带 #）',
      '  --platforms a,b      只处理指定平台；省略=全部 7 个',
      '  --check              只检测各平台登录态，不上传',
      '  --login-wait <秒>    未登录时停在登录页等你扫码的时长，默认 300；0=不等',
      '  --port <端口>        调试端口，默认 9341',
      '  --profile <目录>     指定 Chrome 配置目录',
      `  平台 id：${PLATFORMS.map((p) => p.id).join(', ')}`,
      '',
      '行为：填完即停，标签页全部保留，发布由你手动点。',
    ].join('\n')
  );
}

async function main() {
  if (args.help) {
    usage();
    return { ok: true, help: true };
  }

  const wantedIds = String(args.platforms || '')
    .split(/[,，\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const targets = wantedIds.length ? wantedIds.map(getPlatform) : PLATFORMS;

  let tags = [];
  if (!args.check) {
    if (!args.video) throw new Error('缺少 --video');
    if (!fs.existsSync(args.video)) throw new Error(`视频不存在：${args.video}`);
    if (!args.title) throw new Error('缺少 --title');
    tags = String(args.tags || '')
      .split(/[,，、\s]+/)
      .map((t) => t.trim().replace(/^#+/, ''))
      .filter(Boolean);
  }

  let profileDir = args.profile;
  let wsUrl = '';
  // 优先复用已经在调试端口上的 Chrome（比如刚跑过 --check、或你扫码登录用的那个窗口）
  try {
    const v = await getJson(`http://127.0.0.1:${args.port}/json/version`);
    wsUrl = v.webSocketDebuggerUrl;
    log('复用已运行的 Chrome 调试实例');
  } catch (e) {
    /* 需要自己起一个 */
  }

  if (!wsUrl) {
    // 只用独立 profile：绝不再指向 %LOCALAPPDATA%\Google\Chrome\User Data。
    // 原因：并发的第二个实例会重写那里的 Local State，把 Google 账号登录态冲掉。
    if (!profileDir) profileDir = DEFAULT_PROFILE;
    fs.mkdirSync(profileDir, { recursive: true });
    wsUrl = await launchChrome(profileDir, args.port);
  }

  const browser = new Cdp(wsUrl);
  await browser.connect();

  const results = [];
  try {
    for (const cfg of targets) {
      log(`\n=== ${cfg.name}（${cfg.id}）confidence=${cfg.confidence} ===`);
      if (args.check) {
        const opened = await openTab(browser, args.port, cfg.entry, true);
        await sleep(6000);
        // 与正式流程用同一套判定（含首次启动的 cookie 竞态重试），否则会误报未登录
        const login = await ensureLoggedIn(opened.page, cfg, 0);
        results.push({ id: cfg.id, name: cfg.name, loggedIn: login.ok, url: login.url || cfg.loginUrl });
        log(`  ${login.ok ? '✓ 已登录' : '✗ 未登录'}  ${login.url || cfg.loginUrl}`);
        opened.page.close();
        continue;
      }
      results.push(await runPlatform(browser, cfg, { video: args.video, title: args.title, desc: args.desc, tags }));
    }
  } finally {
    browser.close();
  }

  const summary = {
    ok: true,
    mode: args.check ? 'check' : 'fill-only',
    published: false,
    note: '本工具不发布。所有标签页已保留在填写完成的状态，请逐个人工确认后点发布。',
    results,
  };
  return summary;
}

main()
  .then((res) => {
    console.log(JSON.stringify(res, null, 2));
    process.exit(0);
  })
  .catch((err) => {
    console.log(JSON.stringify({ ok: false, error: (err && err.message) || String(err) }, null, 2));
    process.exit(1);
  });
