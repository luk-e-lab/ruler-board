// 진행판 HTTP(로컬 전용, 127.0.0.1). stdout은 MCP 통신용이라 로그는 stderr로만.
'use strict';
const nodeHttp = require('http');
const fs = require('fs');
const path = require('path');
const store = require('./store');

const WEB = path.join(__dirname, '..', 'web');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml' };

function json(res, code, obj, extra) {
  res.writeHead(code, { 'Content-Type': TYPES['.json'], 'Cache-Control': 'no-store', ...(extra || {}) });
  res.end(JSON.stringify(obj));
}

function handler(req, res) {
  const url = new URL(req.url, 'http://x');
  // 이 포트를 쥔 게 ruler인지, 같은 데이터 폴더인지 다른 프로세스가 확인할 때 씀
  if (url.pathname === '/api/ping') return json(res, 200, { app: 'ruler', home: store.HOME, pc: store.PC, pid: process.pid });
  if (url.pathname === '/api/state') {
    const tag = store.etag();
    if (req.headers['if-none-match'] === tag) { res.writeHead(304); return res.end(); }
    return json(res, 200, store.state(), { ETag: tag });
  }
  if (url.pathname === '/api/decide' && req.method === 'POST') {
    // 사용자 지정 헤더 요구 → 다른 사이트에서 몰래 보내는 요청(CSRF) 차단
    if (req.headers['x-ruler'] !== '1') return json(res, 403, { error: 'header' });
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 1e4) req.destroy(); });
    req.on('end', () => {
      try {
        const b = JSON.parse(body);
        // 결정한 사람은 a='user(web)'. account·session·pc는 진행판을 쥔 프로세스의 것
        store.append({ k: 'decide', p: String(b.project), id: String(b.id), ok: !!b.ok, note: String(b.note || '').slice(0, 300), a: 'user(web)' });
        json(res, 200, { ok: true });
      } catch (e) { json(res, 400, { error: String(e.message) }); }
    });
    return;
  }
  // 정적 파일(web/ 밖으로 못 나가게)
  let p = decodeURIComponent(url.pathname);
  if (p === '/') p = '/index.html';
  const file = path.normalize(path.join(WEB, p));
  if (!file.startsWith(WEB)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(data);
  });
}

// ---------- 포트 정하기 ----------
// 선호 포트(RULER_PORT → config port → 47810)부터 차례로 본다.
//   같은 데이터 폴더의 ruler가 이미 쥐고 있음 → 그 세션이 진행판을 맡음(띄우지 않고, 그 세션이 끝나면 이어받음)
//   다른 프로그램(또는 다른 폴더의 ruler)이 쥐고 있음 → 다음 포트(최대 20개), 다 막히면 OS가 주는 빈 포트
// 실제로 뜬 포트는 <home>/board-<pc>.json 에 적는다(PC마다 따로 — 동기화 폴더에서 서로 덮어쓰지 않게).
const SPAN = 20;
const RETRY_MS = Number(process.env.RULER_RETRY_MS || 15000);

function ping(port) {
  return new Promise((resolve) => {
    const rq = nodeHttp.get({ host: '127.0.0.1', port, path: '/api/ping', timeout: 800 }, (res) => {
      let s = ''; res.on('data', (c) => (s += c));
      res.on('end', () => { try { const j = JSON.parse(s); resolve(j && j.app === 'ruler' ? j : 'other'); } catch { resolve('other'); } });
    });
    rq.on('timeout', () => { rq.destroy(); resolve('other'); });
    rq.on('error', () => resolve(null)); // 아무도 안 받음
  });
}
const ours = (j) => j && j !== 'other' && path.resolve(j.home) === path.resolve(store.HOME) && j.pc === store.PC;

function listen(port) {
  return new Promise((resolve) => {
    const srv = nodeHttp.createServer(handler);
    srv.once('error', () => resolve(null));
    srv.listen(port, '127.0.0.1', () => resolve(srv));
  });
}

let serving = null;
// 진행판을 이 프로세스가 맡거나(포트 돌려줌), 이미 맡은 ruler가 있으면 null
async function claim() {
  const known = store.boardPort();
  if (known && ours(await ping(known))) return null;
  const pref = store.PORT;
  for (let port = pref; port < pref + SPAN; port++) {
    const who = await ping(port);
    if (ours(who)) return null;
    if (who) continue; // 다른 프로그램
    const srv = await listen(port);
    if (srv) { serving = srv; return port; }
  }
  const srv = await listen(0);
  if (srv) { serving = srv; return srv.address().port; }
  return null;
}

// MCP 서버용: 맡을 수 있으면 맡고, 다른 세션이 맡고 있으면 주기적으로 다시 봐서 그 세션이 끝나면 이어받는다
function serveWithRetry() {
  const tick = async () => {
    try {
      const port = await claim();
      if (port) {
        store.writeBoard(port);
        process.stderr.write(`[ruler] 진행판 http://127.0.0.1:${port}\n`);
        const bye = () => store.clearBoard(port);
        process.once('exit', bye);
        return;
      }
    } catch (e) { process.stderr.write('[ruler] http 오류 ' + e.message + '\n'); }
    setTimeout(tick, RETRY_MS).unref();
  };
  tick();
}

module.exports = { serveWithRetry, handler, claim, ping };

// 단독 실행: node server/http.js
if (require.main === module) {
  claim().then((port) => {
    if (!port) { process.stderr.write(`이미 떠 있음: http://127.0.0.1:${store.boardPort()}\n`); process.exit(0); }
    store.writeBoard(port);
    process.on('SIGINT', () => { store.clearBoard(port); process.exit(0); });
    process.stderr.write(`진행판 http://127.0.0.1:${port}\n`);
  });
}
