#!/usr/bin/env node
// 통합 데모: 두 계정(개인·회사) 세션이 한 프로젝트를 계획 → 진행 → 막힘 → 웹 승인 → 완료까지 함께 진행한다.
// 실제 데이터는 건드리지 않는다: 임시 home·임시 설정 폴더, 진행판은 데모 포트 47806.
//
//   node test/demo.js            한 단계씩 천천히(1.2초), 끝나면 종료
//   node test/demo.js --keep     끝난 뒤 진행판을 계속 띄워 둠(스크린샷용, Ctrl+C로 끝)
//   node test/demo.js --web      막힘 단계에서 멈추고, 사용자가 진행판에서 A2를 승인해야 이어짐(--keep 포함)
//   node test/demo.js --fast     쉬지 않고(테스트용, npm test에서 씀)
//   RULER_DEMO_PORT=47900 ...    포트 바꾸기
'use strict';
const { spawn, spawnSync } = require('child_process');
const os = require('os'), fs = require('fs'), path = require('path'), http = require('http');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const argv = process.argv.slice(2);
const WEB = argv.includes('--web');                       // 승인을 사람이 진행판에서 직접 누름
const KEEP = argv.includes('--keep') || WEB, FAST = argv.includes('--fast');
const PORT = Number(process.env.RULER_DEMO_PORT || 47806);
if ([47800, 47801, 47805, 47810].includes(PORT)) { console.error(`포트 ${PORT}은 데모에 쓰지 않음`); process.exit(1); }
const PAUSE = FAST ? 0 : 1200;
const P = 'demo';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ruler-demo-'));
const home = path.join(tmp, 'home'), cfg = path.join(tmp, 'cfg');
fs.mkdirSync(path.join(cfg, 'ruler'), { recursive: true });
// 실제 설치처럼 계정 UUID에 별명을 붙인다(가짜 UUID)
fs.writeFileSync(path.join(cfg, 'ruler', 'config.json'), JSON.stringify({ accounts: { 'demo-uuid-a': '개인', 'demo-uuid-b': '회사' } }));
const base = { ...process.env, APPDATA: cfg, XDG_CONFIG_HOME: cfg, RULER_HOME: home, RULER_PORT: String(PORT) };
for (const k of Object.keys(base)) if (/^(RULER_(AGENT|PC|NO_HTTP)|CLAUDE_CODE_|CLAUDE_PROJECT_DIR)/.test(k)) delete base[k];
const ENV = {
  개인: { CLAUDE_CODE_ACCOUNT_UUID: 'demo-uuid-a', CLAUDE_CODE_HOST_SESSION_ID: 'local_demo-a' },
  회사: { CLAUDE_CODE_ACCOUNT_UUID: 'demo-uuid-b', CLAUDE_CODE_HOST_SESSION_ID: 'local_demo-b', RULER_NO_HTTP: '1' },
};
const procs = [];
const cleanup = () => { for (const cp of procs) try { cp.kill(); } catch {} try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let stepNo = 0;
const step = async (title) => { await sleep(PAUSE); console.log(`\n── ${++stepNo}. ${title}`); };
const say = (who, text) => console.log(`  ${who.padEnd(4)} │ ${String(text).replace(/\n/g, '\n       │ ')}`);

function server(account) {
  const cp = spawn(process.execPath, [path.join(ROOT, 'server', 'mcp.js')], { env: { ...base, ...ENV[account] }, stdio: ['pipe', 'pipe', 'ignore'] });
  procs.push(cp);
  let buf = '', id = 0; const wait = {};
  cp.stdout.on('data', (c) => { buf += c; let i; while ((i = buf.indexOf('\n')) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); wait[m.id](m); } });
  const rpc = (method, params) => new Promise((r) => { wait[++id] = r; cp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
  const t = async (name, args) => {
    const r = (await rpc('tools/call', { name, arguments: args })).result;
    say(account, `${name} ${JSON.stringify(args)}\n→ ${r.content[0].text}`);
    assert.ok(!r.isError, r.content[0].text);
    return r.content[0].text;
  };
  return { rpc, t };
}

// 훅 한 번 실행(실제 앱이 hooks/hook.js에 주는 입력과 같은 모양)
function hook(account, input) {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'hooks', 'hook.js')], {
    env: { ...base, ...ENV[account] }, input: JSON.stringify({ session_id: 'cc-' + account, cwd: ROOT, ...input }), encoding: 'utf8',
  });
  return r.stdout;
}

function req(method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const rq = http.request({ host: '127.0.0.1', port: PORT, path: p, method, headers: { 'X-Ruler': '1', 'Content-Type': 'application/json' } }, (res) => {
      let s = ''; res.on('data', (c) => (s += c)); res.on('end', () => resolve({ code: res.statusCode, body: s }));
    });
    rq.on('error', reject); if (data) rq.write(data); rq.end();
  });
}
async function waitHttp() {
  for (let i = 0; i < 50; i++) { try { if ((await req('GET', '/api/state')).code === 200) return; } catch {} await sleep(100); }
  throw new Error(`진행판이 ${PORT}에서 안 뜸 — 다른 프로그램이 포트를 쓰는지 확인(RULER_DEMO_PORT로 바꾸기)`);
}

(async () => {
  // 포트가 이미 쓰이면(다른 데모가 떠 있으면) 그쪽에 쓰지 않도록 멈춘다
  if (await req('GET', '/').then(() => true, () => false)) {
    console.error(`포트 ${PORT}을 이미 다른 프로그램(다른 데모?)이 쓰는 중 — 그것을 끄거나 RULER_DEMO_PORT로 다른 포트를 주세요`);
    cleanup();
    process.exit(1);
  }
  console.log(`Ruler 통합 데모 — 임시 home ${home}\n진행판 http://127.0.0.1:${PORT}`);
  const me = server('개인'), co = server('회사');
  for (const s of [me, co]) await s.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'demo', version: '0' } });
  await waitHttp();

  await step('두 세션 시작 — 설정·bind 없이 바로 쓴다');
  hook('개인', { hook_event_name: 'SessionStart', source: 'startup' });
  hook('회사', { hook_event_name: 'SessionStart', source: 'startup' });

  await step('계획 — 개인 계정 세션이 큰 눈금 3개를 제안, 사용자가 채팅에서 승인');
  await me.t('ruler_plan', { project: P, agent: 'main', majors: ['API 서버', '진행판 화면', '출시 점검'], note: '사용자와 합의할 큰 단계' });
  say('사용자', '(채팅) "승인"');
  await me.t('ruler_decide', { id: 'A1', ok: true, note: '채팅 승인' });

  await step('작은 눈금 — 각자 맡은 큰 눈금을 쪼갠다(회사 쪽은 bind로 이름·맡은 큰 눈금만)');
  await me.t('ruler_split', { major: 'M1', add: ['저장소', '도구 8개', '로컬 HTTP'] });
  await co.t('ruler_bind', { project: P, agent: 'web', major: 'M2' });
  await co.t('ruler_split', { major: 'M2', add: ['블록 4개', '계정 필터'] });

  await step('진행 — doing 답에 여기서 일하는 다른 세션이 붙는다');
  await me.t('ruler_tick', { id: 'M1.1', st: 'doing' });
  await co.t('ruler_status', { account: '개인' });
  const d = await co.t('ruler_tick', { id: 'M2.1', st: 'doing' });
  assert.match(d, /다른 세션: ▶ M1.1 저장소 \(main·개인\)/);
  hook('개인', { hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: 'server/store.js' } });
  await me.t('ruler_tick', { id: 'M1.1', st: 'done' });
  await me.t('ruler_tick', { id: 'M1.2', st: 'doing' });

  await step('막힘 — 결정이 필요해 승인 요청을 올린다');
  await me.t('ruler_tick', { id: 'M1.2', st: 'blocked', note: '도구 이름 규칙 결정 필요' });
  await me.t('ruler_ask', { text: '도구 이름을 ruler_* 로 통일해도 되나', target: 'M1.2' });

  await step('승인 — 사용자가 진행판(웹)에서 승인 버튼');
  if (WEB) {
    console.log(`  → 진행판 http://127.0.0.1:${PORT} 에서 A2를 승인(또는 거절)하면 이어집니다`);
    for (;;) {
      const s = JSON.parse((await req('GET', '/api/state')).body);
      const a = s.projects[P].approvals.find((x) => x.id === 'A2');
      if (a && a.st !== 'pending') break;
      await sleep(1000);
    }
  } else {
    const r = await req('POST', '/api/decide', { project: P, id: 'A2', ok: true, note: 'ruler_* 로 통일' });
    assert.equal(r.code, 200, r.body);
    say('사용자', '(웹) A2 승인 — ruler_* 로 통일');
  }
  // 요청한 세션의 다음 도구 호출 때 훅이 결과를 한 번만 모델에게 넘긴다. 다른 세션에는 안 감
  assert.equal(hook('회사', { hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: {} }), '');
  const out1 = hook('개인', { hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: {} });
  const out2 = hook('개인', { hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: {} });
  const ctx = out1 && JSON.parse(out1).hookSpecificOutput.additionalContext;
  say('훅', `main에게 전달: ${ctx}\n두 번째 호출 출력: ${out2 ? out2 : '(비어 있음)'}`);
  assert.match(ctx || '', WEB ? new RegExp(`^ruler: ${P} A2 (승인됨|거절됨)`) : /^ruler: demo A2 승인됨 — ruler_\* 로 통일$/);
  assert.equal(out2, '');

  await step('완료 — 작은 눈금이 다 끝나면 큰 눈금이 저절로 완료');
  await me.t('ruler_tick', { id: 'M1.2', st: 'done' });
  await me.t('ruler_tick', { id: 'M1.3', st: 'done' });
  await co.t('ruler_tick', { id: 'M2.1', st: 'done' });
  await co.t('ruler_tick', { id: 'M2.2', st: 'doing' });
  await co.t('ruler_tick', { id: 'M2.2', st: 'done' });
  await co.t('ruler_handoff', { to: 'main', note: '화면 끝, 출시 점검 넘김' });
  await me.t('ruler_split', { major: 'M3', add: ['스크린샷·README'] });
  await me.t('ruler_tick', { id: 'M3.1', st: 'done' });
  hook('개인', { hook_event_name: 'Stop' });

  await step('결과');
  await me.t('ruler_status', { all: true });
  const st = JSON.parse((await req('GET', '/api/state')).body);
  const kinds = new Set(st.feed.flatMap((f) => (f.notes || []).map((n) => n.kind)));
  for (const k of ['major_done', 'blocked', 'approval']) assert.ok(kinds.has(k), '알림 ' + k + ' 없음');
  assert.ok(st.projects[P].majors.every((M) => M.st === 'done'));
  assert.ok(st.edges.some((e) => e.from === 'web' && e.to === 'main'));
  assert.deepEqual(Object.values(st.accounts).map((A) => A.name).sort(), ['개인', '회사']);
  assert.ok(!st.agents['user(web)'] && !st.agents.user, '사용자 결정이 에이전트 노드로 잡힘');
  const shards = fs.readdirSync(path.join(home, 'events'));
  assert.equal(shards.length, 1);
  const lines = fs.readFileSync(path.join(home, 'events', shards[0]), 'utf8').trim().split('\n').map(JSON.parse);
  for (const e of lines) { assert.match(e.account, /^[0-9a-f]{8}$/, JSON.stringify(e)); assert.match(e.session, /^local_demo-/); }
  console.log(`\n데모 ok — 이벤트 ${lines.length}줄, 알림 ${[...kinds].join('·')}`);

  const end = () => { cleanup(); process.exit(0); };
  if (KEEP) { console.log(`진행판 http://127.0.0.1:${PORT} 띄워 둠 — Ctrl+C로 끝`); process.on('SIGINT', end); process.on('SIGTERM', end); }
  else end();
})().catch((e) => { console.error(e); cleanup(); process.exit(1); });
