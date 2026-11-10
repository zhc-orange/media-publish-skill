'use strict';

/**
 * 在指定调试端口的 Chrome 里批量开标签页（用 PUT /json/new，GET 会被拒）。
 * 用法：node open-tabs.js <port> <url> [url...]
 */

const http = require('node:http');

const PORT = Number(process.argv[2] || 9341);
const URLS = process.argv.slice(3);
if (!URLS.length) {
  console.error('用法：node open-tabs.js <port> <url> [url...]');
  process.exit(1);
}

function openTab(url) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: PORT, path: `/json/new?${encodeURIComponent(url)}`, method: 'PUT' },
      (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(d));
          } catch (e) {
            reject(new Error('bad json: ' + d.slice(0, 80)));
          }
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

(async () => {
  for (const url of URLS) {
    try {
      const t = await openTab(url);
      console.log(`OK  ${url}  -> ${t.id}`);
    } catch (e) {
      console.log(`ERR ${url}  ${e.message}`);
    }
    await new Promise((r) => setTimeout(r, 800));
  }
})();
