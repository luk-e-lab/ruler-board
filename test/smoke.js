// 스모크 테스트: 임시 폴더에서 server/mcp.js 를 여러 신원으로 띄워 도구를 불러 본다(네트워크 없음).
// ① 설정 없음(계정 1개, bind 없이, 프로젝트=폴더 이름) ② 한 PC 두 계정 ③ 두 PC(조각 2개) ④ 옛 한 파일 로그 ⑤ config home
'use strict';
const { spawn } = require('child_process');
const os = require('os'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const assert = require('assert');

const T = fs.mkdtempSync(path.join(os.tmpdir(), 'ruler-smoke-'));
const CFG = path.join(T, 'cfg'); // 가짜 %APPDATA% / ~/.config — 사용자의 진짜 설정을 읽지 않게
const DEF = path.join(CFG, 'ruler');
fs.mkdirSync(DEF, { recursive: true });
const base = { ...process.env, APPDATA: CFG, XDG_CONFIG_HOME: CFG, RULER_NO_HTTP: '1' };
for (const k of Object.keys(base)) if (/^(RULER_(?!NO_HTTP)|CLAUDE_CODE_|CLAUDE_PROJECT_DIR)/.test(k)) delete base[k];
const sha8 = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 8);
const lines = (f) => fs.readFileSync(f, 'utf8').trim().split('\n').map(JSON.parse);
const procs = [];

function server(env, cwd) {
  const cp = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'mcp.js')], { env: { ...base, ...env }, cwd: cwd || T });
  procs.push(cp);
  let buf = '', id = 0; const wait = {};
  cp.stdout.on('data', (c) => { buf += c; let i; while ((i = buf.indexOf('\n')) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); wait[m.id](m); } });
  const rpc = (method, params) => new Promise((r) => { wait[++id] = r; cp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
  const t = async (name, args) => { const r = (await rpc('tools/call', { name, arguments: args })).result; assert.ok(!r.isError, name + ': ' + r.content[0].text); return r.content[0].text; };
  return { rpc, t, cp };
}

(async () => {
  // ① 설정 없음: RULER_HOME·계정 UUID·세션 id 없음. 기본 폴더에, 계정 local, 프로젝트 = 폴더 이름
  const proj = path.join(T, 'myproj'); fs.mkdirSync(proj);
  const solo = server({}, proj);
  const init = await solo.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } });
  assert.equal(init.result.serverInfo.version, '1.0.0');
  assert.equal((await solo.rpc('tools/list', {})).result.tools.length, 8);
  assert.match(await solo.t('ruler_plan', { majors: ['가', '나'] }), /^A1 승인대기 \(myproj\)/);
  await solo.t('ruler_decide', { id: 'A1', ok: true });
  assert.match(await solo.t('ruler_split', { major: 'M1', add: ['a', 'b'] }), /M1.1,M1.2/);
  assert.match(await solo.t('ruler_tick', { id: 'M1.1', st: 'doing' }), /다른 세션: 없음/);
  assert.match(await solo.t('ruler_status', {}), /\[myproj\][\s\S]*M1 가 0\/2/);
  const shards = fs.readdirSync(path.join(DEF, 'events'));
  assert.equal(shards.length, 1);
  for (const e of lines(path.join(DEF, 'events', shards[0]))) { assert.equal(e.account, 'local'); assert.match(e.session, /^proc-/); assert.equal(e.pc + '.jsonl', shards[0]); }
  console.log('① 설정 없음 ok —', shards[0]);

  // ② 한 PC 두 계정, 같은 home. 별명: 기본 설정엔 UUID로, home 설정엔 짧은 id로
  const H2 = path.join(T, 'h2');
  fs.writeFileSync(path.join(DEF, 'config.json'), JSON.stringify({ accounts: { 'uuid-a': '개인' } }));
  fs.mkdirSync(H2); fs.writeFileSync(path.join(H2, 'config.json'), JSON.stringify({ accounts: { [sha8('uuid-b')]: '회사' } }));
  const A = server({ RULER_HOME: H2, CLAUDE_CODE_ACCOUNT_UUID: 'uuid-a', CLAUDE_CODE_HOST_SESSION_ID: 'local_a' });
  const B = server({ RULER_HOME: H2, CLAUDE_CODE_ACCOUNT_UUID: 'uuid-b', CLAUDE_CODE_HOST_SESSION_ID: 'local_b' });
  await A.t('ruler_plan', { project: 'shared', agent: 'main', majors: ['서버', '화면'] });
  await A.t('ruler_decide', { id: 'A1', ok: true });
  await A.t('ruler_split', { major: 'M1', add: ['저장소'] });
  assert.match(await B.t('ruler_bind', { project: 'shared', agent: 'worker', major: 'M2' }), /^ok shared M2 \(회사·local_b\)/);
  await B.t('ruler_split', { major: 'M2', add: ['x', 'y'] });
  await B.t('ruler_tick', { id: 'M2.1', st: 'doing' });
  assert.match(await A.t('ruler_tick', { id: 'M1.1', st: 'doing' }), /다른 세션: ▶ M2.1 x \(worker·회사\)/);
  const sb = await A.t('ruler_status', { account: '회사' });
  assert.match(sb, /^회사:/m); assert.match(sb, /M2.1 x/); assert.doesNotMatch(sb, /M1.1/);
  assert.match(await B.t('ruler_status', { account: sha8('uuid-a') }), /^개인:[\s\S]*M1.1 저장소/m);
  const evA = lines(path.join(H2, 'events', fs.readdirSync(path.join(H2, 'events'))[0]));
  assert.deepEqual([...new Set(evA.map((e) => e.account))].sort(), [sha8('uuid-a'), sha8('uuid-b')].sort());
  console.log('② 두 계정 ok');

  // ③ 두 PC, 같은 home(동기화 폴더 흉내) → 조각 2개, 각 파일은 한 PC만 씀, 상태는 합쳐짐
  const H3 = path.join(T, 'h3');
  const P1 = server({ RULER_HOME: H3, RULER_PC: 'pc-one', CLAUDE_CODE_HOST_SESSION_ID: 'local_p1' });
  const P2 = server({ RULER_HOME: H3, RULER_PC: 'pc-two', CLAUDE_CODE_HOST_SESSION_ID: 'local_p2' });
  await P1.t('ruler_plan', { project: 'multi', majors: ['하나'] });
  await P2.t('ruler_decide', { project: 'multi', id: 'A1', ok: true }); // 다른 PC의 승인 요청을 결정
  await P1.t('ruler_split', { major: 'M1', add: ['p', 'q'] });
  await P2.t('ruler_tick', { id: 'M1.1', st: 'done' });
  assert.match(await P1.t('ruler_tick', { id: 'M1.2', st: 'done' }), /ok M1 2\/2 done/);
  assert.deepEqual(fs.readdirSync(path.join(H3, 'events')).sort(), ['pc-one.jsonl', 'pc-two.jsonl']);
  for (const pc of ['pc-one', 'pc-two']) for (const e of lines(path.join(H3, 'events', pc + '.jsonl'))) assert.equal(e.pc, pc);
  assert.ok(!fs.existsSync(path.join(H3, 'events.jsonl')));
  console.log('③ 두 PC ok');

  // ④ 옛 한 파일 로그(<home>/events.jsonl, pc 없음)도 읽고 이어 쓴다
  const H4 = path.join(T, 'h4'); fs.mkdirSync(H4);
  const t0 = Date.now() - 60000, at = (i) => new Date(t0 + i * 1000).toISOString();
  fs.writeFileSync(path.join(H4, 'events.jsonl'), [
    { k: 'plan', p: 'old', majors: ['옛 일'], account: 'OLD', session: 'local_old', t: at(0) },
    { k: 'decide', p: 'old', id: 'A1', ok: true, account: 'OLD', session: 'local_old', t: at(1) },
    { k: 'split', p: 'old', major: 'M1', add: ['옛 작은 일'], account: 'OLD', session: 'local_old', t: at(2) },
    { k: 'hook', ev: 'Stop', h: 'local_old', t: at(3) },
  ].map((e) => JSON.stringify(e)).join('\n') + '\n');
  const L = server({ RULER_HOME: H4 });
  assert.match(await L.t('ruler_tick', { project: 'old', id: 'M1.1', st: 'done' }), /ok M1 1\/1 done/);
  assert.match(await L.t('ruler_status', { account: 'OLD' }), /M1 옛 일/);
  assert.equal(lines(path.join(H4, 'events.jsonl')).length, 4); // 옛 파일은 건드리지 않음
  console.log('④ 옛 로그 ok');

  // ⑤ 기본 설정의 home으로 데이터 폴더 옮기기
  const H5 = path.join(T, 'synced');
  fs.writeFileSync(path.join(DEF, 'config.json'), JSON.stringify({ home: H5, pc: 'Desk Top!' }));
  await server({}, proj).t('ruler_plan', { majors: ['z'] });
  assert.deepEqual(fs.readdirSync(path.join(H5, 'events')), ['desk-top.jsonl']);
  console.log('⑤ config home·pc ok');

  // ⑥ 포트: 선호 포트를 다른 프로그램이 쓰면 비켜 가고, 같은 폴더의 ruler끼리는 하나만 띄우고 이어받는다
  const http = require('http');
  const foreign = http.createServer((q, s) => s.end('not ruler'));
  await new Promise((r) => foreign.listen(0, '127.0.0.1', r));
  const FP = foreign.address().port;
  const H6 = path.join(T, 'h6'), H6b = path.join(T, 'h6b');
  const env6 = (home) => ({ RULER_HOME: home, RULER_PC: 'p6', RULER_PORT: String(FP), RULER_NO_HTTP: '', RULER_RETRY_MS: '200' });
  const board = (home) => { try { return JSON.parse(fs.readFileSync(path.join(home, 'board-p6.json'), 'utf8')); } catch { return {}; } };
  const until = async (f, what) => { for (let i = 0; i < 60; i++) { if (f()) return; await new Promise((r) => setTimeout(r, 100)); } throw new Error('시간 초과: ' + what); };
  const pingJ = (port) => new Promise((r) => http.get({ host: '127.0.0.1', port, path: '/api/ping' }, (s) => { let b = ''; s.on('data', (c) => (b += c)); s.on('end', () => r(JSON.parse(b))); }).on('error', () => r(null)));

  const S1 = server(env6(H6), proj);
  await until(() => board(H6).port, '첫 진행판');
  const BP = board(H6).port;
  assert.notEqual(BP, FP, '다른 프로그램의 포트를 쓰면 안 됨');
  assert.equal((await pingJ(BP)).app, 'ruler');
  assert.equal(board(H6).pid, S1.cp.pid);
  const S2 = server(env6(H6), proj); // 같은 폴더 → 띄우지 않음
  await new Promise((r) => setTimeout(r, 600));
  assert.equal(board(H6).pid, S1.cp.pid, '같은 폴더 두 번째 세션이 진행판을 또 띄움');
  assert.match(await S2.t('ruler_status', {}), new RegExp('^진행판 http://127.0.0.1:' + BP));
  const S3 = server(env6(H6b), proj); // 다른 폴더의 ruler → 그 포트도 비켜 감
  await until(() => board(H6b).port, '다른 폴더 진행판');
  assert.ok(![FP, BP].includes(board(H6b).port), '다른 폴더 ruler와 포트 겹침');
  S1.cp.kill();
  await until(() => board(H6).pid === S2.cp.pid, '이어받기');
  assert.equal((await pingJ(board(H6).port)).app, 'ruler');
  foreign.close();
  console.log(`⑥ 포트 ok — 남의 ${FP} 비켜 ${BP}, 다른 폴더 ${board(H6b).port}, 끝난 세션 이어받음`);
  void S3;

  for (const cp of procs) cp.kill();
  setTimeout(() => { try { fs.rmSync(T, { recursive: true, force: true }); } catch {} console.log('smoke ok'); }, 200);
})().catch((e) => { console.error(e); for (const cp of procs) cp.kill(); process.exit(1); });
