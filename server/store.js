// 저장소: 추가만 하는 이벤트 로그(JSONL)가 원본. 상태는 로그를 다시 읽어 계산한다.
// PC마다 자기 조각 <home>/events/<pc>.jsonl 에만 append → 동기화 폴더(OneDrive 등)에 두어도 충돌 없음.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

// ---------- 설정 ----------
// 기본 폴더: Windows %APPDATA%\ruler, 그 밖 ~/.config/ruler. 설정은 <기본 폴더>/config.json
// (home을 다른 곳으로 옮겼다면 <home>/config.json 도 읽는다 — 여러 PC가 같이 쓰는 계정 별명 등)
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return {}; } };
const DEFAULT_DIR = process.platform === 'win32'
  ? path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'ruler')
  : path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'ruler');
const local = readJson(path.join(DEFAULT_DIR, 'config.json'));
const HOME = path.resolve(process.env.RULER_HOME || local.home || DEFAULT_DIR);
const shared = HOME === path.resolve(DEFAULT_DIR) ? {} : readJson(path.join(HOME, 'config.json'));
const CONFIG = { ...shared, ...local, accounts: { ...shared.accounts, ...local.accounts } };

const clean = (s) => String(s).toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'pc';
const PC = clean(process.env.RULER_PC || CONFIG.pc || os.hostname());
const PORT = Number(process.env.RULER_PORT || CONFIG.port || 47810);
const DIR = path.join(HOME, 'events');
const LOG = path.join(DIR, PC + '.jsonl'); // 이 PC가 쓰는 유일한 파일
const LEGACY = path.join(HOME, 'events.jsonl'); // 옛 한 파일 로그(읽기만)
const MAX_LINE = 4096;

// ---------- 신원 ----------
// 계정 = CLAUDE_CODE_ACCOUNT_UUID의 sha1 앞 8자리(없으면 local). 별명은 config accounts에서.
const shortId = (uuid) => (uuid ? crypto.createHash('sha1').update(String(uuid)).digest('hex').slice(0, 8) : 'local');
const ALIAS = {};
for (const [k, v] of Object.entries(CONFIG.accounts || {})) ALIAS[/^([0-9a-f]{8}|local)$/.test(k) ? k : shortId(k)] = String(v);
const accountName = (id) => ALIAS[id] || (id === 'local' ? '기본' : id === '?' ? '?' : '계정 ' + String(id).slice(0, 4));

const FALLBACK_SESSION = 'proc-' + process.pid + '-' + Date.now().toString(36);
function identity() {
  const env = process.env;
  return {
    account: shortId(env.CLAUDE_CODE_ACCOUNT_UUID),
    session: env.CLAUDE_CODE_HOST_SESSION_ID || env.CLAUDE_CODE_SESSION_ID || FALLBACK_SESSION,
    pc: PC,
  };
}

// 한 줄 append. 계정이 무엇이든 막지 않는다.
function append(ev) {
  fs.mkdirSync(DIR, { recursive: true });
  const me = identity();
  ev.account = ev.account || me.account;
  ev.session = ev.session || me.session;
  ev.pc = PC;
  ev.t = ev.t || new Date().toISOString();
  const line = JSON.stringify(ev);
  if (Buffer.byteLength(line) > MAX_LINE) throw new Error('이벤트가 4KB를 넘음');
  fs.appendFileSync(LOG, line + '\n');
  return ev;
}

// ---------- 읽기: 모든 조각 + 옛 파일을 t 순으로 합침 ----------
function files() {
  let names = [];
  try { names = fs.readdirSync(DIR).filter((n) => n.endsWith('.jsonl')).sort(); } catch {}
  return [LEGACY, ...names.map((n) => path.join(DIR, n))];
}
function stats() {
  return files().map((f) => { try { const s = fs.statSync(f); return { f, size: s.size, mtime: s.mtimeMs }; } catch { return null; } }).filter(Boolean);
}
function etag() { return '"' + stats().map((s) => s.size + '-' + Math.floor(s.mtime)).join('.') + '"'; }

const perFile = {}; // f → { size, events } (늘어난 부분만 다시 읽기)
let merged = { tag: null, events: [] };
function readFile({ f, size }) {
  const c = perFile[f];
  if (c && c.size === size) return c.events;
  let text, events = [];
  if (c && size > c.size) {
    const fd = fs.openSync(f, 'r'), buf = Buffer.alloc(size - c.size);
    fs.readSync(fd, buf, 0, buf.length, c.size); fs.closeSync(fd);
    text = buf.toString('utf8'); events = c.events.slice();
  } else text = fs.readFileSync(f, 'utf8');
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      if (e.session === undefined && e.h) e.session = e.h; // v0.1 줄
      events.push(e);
    } catch { /* 깨진 줄은 건너뜀 */ }
  }
  perFile[f] = { size, events };
  return events;
}
function readEvents() {
  const st = stats(), tag = st.map((s) => s.f + s.size).join('|');
  if (tag === merged.tag) return merged.events;
  const all = st.flatMap(readFile);
  all.sort((a, b) => String(a.t || '').localeCompare(String(b.t || ''))); // 안정 정렬: 같은 시각은 파일 순서 유지
  merged = { tag, events: all };
  return all;
}

// ---------- 리듀서 ----------
const ST = ['wait', 'doing', 'done', 'blocked', 'approval'];
const PLAN_ST = { pending: 'wait', in_progress: 'doing', completed: 'done' };

function reduce(events) {
  const S = { projects: {}, sessions: {}, agents: {}, accounts: {}, pcs: [], edges: [], feed: [], last: null };
  const proj = (id) => S.projects[id] || (S.projects[id] = {
    id, majors: [], approvals: [], seq: { M: 0, A: 0 }, cur: null, updated: null, proposed: null,
  });
  // 1차: 세션 → 계정·이름. 나중에 밝힌 이름도 앞 이벤트에 적용되게.
  const sAcct = {}, sName = {};
  for (const ev of events) {
    if (!ev.session) continue;
    if (ev.account) sAcct[ev.session] = ev.account;
    if (ev.a && ev.a !== 'user' && ev.a !== 'user(web)') sName[ev.session] = ev.a;
  }
  const acctOf = (ev) => ev.account || (ev.session && sAcct[ev.session]) || '?';
  const hostName = (h) => sName[h] || String(h).replace(/^(local_|proc-)/, '').replace(/[^0-9a-z]/gi, '').slice(0, 6);
  S.alias = hostName;
  const agentName = (ev) => ev.a || (ev.session ? hostName(ev.session) : acctOf(ev));
  const nameOf = (x) => (x && (S.sessions[x] || sName[x]) ? hostName(x) : x);
  const touchAgent = (name, ev, extra) => {
    if (!name) return;
    const ag = S.agents[name] || (S.agents[name] = { name, account: '?', seen: null, tool: null, project: null, pc: null, sessions: [] });
    ag.seen = ev.t;
    const ac = acctOf(ev); if (ac !== '?') ag.account = ac;
    if (ev.pc) ag.pc = ev.pc;
    if (ev.session && !ag.sessions.includes(ev.session)) ag.sessions.push(ev.session);
    Object.assign(ag, extra || {});
  };
  const findNode = (P, id) => {
    for (const M of P.majors) {
      if (M.id === id) return { node: M, major: M };
      for (const m of M.minors) if (m.id === id) return { node: m, major: M };
    }
    return {};
  };
  const findMajor = (P, ref) => P.majors.find((M) => M.id === ref || M.title === ref);
  const recheckMajor = (P, M, ev, notes) => {
    const live = M.minors.filter((m) => m.st !== 'dropped');
    if (live.length && live.every((m) => m.st === 'done') && M.st !== 'done') {
      M.st = 'done'; M.doneAt = ev.t;
      notes.push({ kind: 'major_done', p: P.id, id: M.id, title: M.title });
    } else if (live.some((m) => m.st !== 'wait') && M.st === 'wait') M.st = 'doing';
  };
  const addMinors = (P, M, titles, ev, auto) => {
    for (const title of titles) {
      M.seq = (M.seq || 0) + 1;
      M.minors.push({ id: `${M.id}.${M.seq}`, title, st: 'wait', agent: agentName(ev), account: acctOf(ev), session: ev.session, auto: !!auto, added: ev.t });
    }
    if (M.firstSplit) M.grew += titles.length; else M.firstSplit = ev.t;
  };
  const applyPlan = (P, titles) => {
    const old = P.majors;
    P.majors = titles.map((title) => {
      const keep = old.find((M) => M.title === title);
      if (keep) return keep;
      P.seq.M += 1;
      return { id: 'M' + P.seq.M, title, st: 'wait', minors: [], seq: 0, grew: 0, firstSplit: null, agent: null };
    });
  };
  const ses = (id) => S.sessions[id] || (S.sessions[id] = { id });

  for (const ev of events) {
    const notes = [];
    const P = ev.p ? proj(ev.p) : null;
    if (P) P.updated = ev.t;
    const who = agentName(ev);
    const acct = acctOf(ev);
    if (acct !== '?') { const A = S.accounts[acct] || (S.accounts[acct] = { id: acct, name: accountName(acct), seen: null }); A.seen = ev.t; }
    if (ev.pc && !S.pcs.includes(ev.pc)) S.pcs.push(ev.pc);
    if (ev.session) { const s = ses(ev.session); s.account = acct; if (ev.pc) s.pc = ev.pc; if (ev.cwd && !s.cwd) { s.cwd = ev.cwd; s.project = s.project || path.basename(ev.cwd); } }
    switch (ev.k) {
      case 'plan': {
        P.seq.A += 1;
        const ap = { id: 'A' + P.seq.A, kind: 'plan', text: ev.note || '큰 눈금 ' + (P.majors.length ? '변경' : '합의'), majors: ev.majors, st: 'pending', agent: who, account: acct, session: ev.session, t: ev.t };
        P.approvals.push(ap); P.proposed = ap.id;
        notes.push({ kind: 'approval', p: P.id, id: ap.id, text: ap.text });
        break;
      }
      case 'ask': {
        P.seq.A += 1;
        const ap = { id: 'A' + P.seq.A, kind: 'ask', text: ev.text, target: ev.target || null, st: 'pending', agent: who, account: acct, session: ev.session, t: ev.t };
        P.approvals.push(ap);
        const { node } = findNode(P, ev.target);
        if (node) { node.prevSt = node.st; node.st = 'approval'; node.ap = ap.id; }
        notes.push({ kind: 'approval', p: P.id, id: ap.id, text: ap.text });
        break;
      }
      case 'decide': {
        const ap = P.approvals.find((x) => x.id === ev.id);
        if (!ap || ap.st !== 'pending') break;
        ap.st = ev.ok ? 'ok' : 'no'; ap.by = ev.a || 'user'; ap.note = ev.note || ''; ap.decidedAt = ev.t;
        if (ap.kind === 'plan') { if (ev.ok) applyPlan(P, ap.majors); P.proposed = null; }
        if (ap.target) {
          const { node } = findNode(P, ap.target);
          if (node && node.ap === ap.id) { node.st = node.prevSt && node.prevSt !== 'approval' ? node.prevSt : 'doing'; delete node.ap; }
        }
        break;
      }
      case 'split': {
        const M = findMajor(P, ev.major);
        if (!M) break;
        if (ev.add && ev.add.length) addMinors(P, M, ev.add, ev);
        for (const id of ev.drop || []) { const m = M.minors.find((x) => x.id === id); if (m) m.st = 'dropped'; }
        M.agent = M.agent || who; M.account = M.account || acct;
        break;
      }
      case 'tick': {
        const { node, major } = findNode(P, ev.id);
        if (!node || !ST.includes(ev.st)) break;
        Object.assign(node, { st: ev.st, note: ev.note || node.note, agent: who, account: acct, session: ev.session, at: ev.t });
        if (ev.st === 'doing') P.cur = node.id;
        if (ev.st === 'blocked') notes.push({ kind: 'blocked', p: P.id, id: node.id, title: node.title, note: ev.note });
        if (node === major) { if (ev.st === 'done') { major.doneAt = ev.t; notes.push({ kind: 'major_done', p: P.id, id: major.id, title: major.title }); } }
        else recheckMajor(P, major, ev, notes);
        break;
      }
      case 'handoff': {
        const to = nameOf(ev.to);
        S.edges.push({ from: nameOf(ev.from) || who, to, note: ev.note || '', t: ev.t, via: ev.via || 'ruler', account: acct });
        if (to && !S.agents[to]) touchAgent(to, { t: ev.t }); // 받기만 한 쪽은 노드만
        break;
      }
      case 'bind': { // 선택: 세션 ↔ 에이전트 이름·프로젝트·큰 눈금
        if (!ev.session) break;
        const s = ses(ev.session);
        if (ev.a) s.agent = ev.a;
        if (ev.p) s.project = ev.p;
        if (ev.major) s.major = ev.major;
        break;
      }
      case 'hplan': { // 훅: 작업 목록(update_plan/TodoWrite) → bind된 큰 눈금의 작은 눈금으로 동기화
        const s = ev.session && S.sessions[ev.session];
        if (!s) break;
        s.plan = s.plan || [];
        if (ev.items) s.plan = ev.items.map((x) => ({ title: x.title, st: PLAN_ST[x.st] || 'wait' }));
        const L = s.plan;
        if (ev.advance) { const i = L.findIndex((x) => x.st === 'doing'); if (i >= 0) L[i].st = 'done'; const j = L.findIndex((x) => x.st === 'wait'); if (j >= 0) L[j].st = 'doing'; }
        for (const n of ev.done || []) if (L[n - 1]) L[n - 1].st = 'done';
        if (ev.start && L[ev.start - 1]) L[ev.start - 1].st = 'doing';
        if (ev.wrap) L.forEach((x) => { if (x.st === 'doing') x.st = 'done'; });
        const P2 = s.project && S.projects[s.project];
        const M = P2 && s.major && findMajor(P2, s.major);
        if (!M) break;
        P2.updated = ev.t;
        const fresh = L.filter((x) => !M.minors.some((m) => m.title === x.title));
        if (fresh.length) addMinors(P2, M, fresh.map((x) => x.title), ev, true);
        for (const x of L) {
          const m = M.minors.find((mm) => mm.title === x.title);
          if (m && m.st !== x.st && m.st !== 'blocked' && m.st !== 'approval') {
            m.st = x.st; m.at = ev.t;
            if (x.st === 'doing') P2.cur = m.id;
          }
        }
        recheckMajor(P2, M, ev, notes);
        break;
      }
      default: break;
    }
    // 에이전트 활동. 사용자 결정('user', 'user(web)')은 에이전트가 아니므로 노드로 만들지 않음
    if (ev.k === 'hook') touchAgent(who, ev, { tool: ev.tool || ev.ev, project: (S.sessions[ev.session] || {}).project || null });
    else if (ev.k !== 'bind' && !(ev.k === 'decide' && (who === 'user' || who === 'user(web)'))) touchAgent(who, ev, P ? { project: P.id } : null);
    S.last = ev.t;
    const feedable = ev.k !== 'bind' && (ev.k !== 'hook' || ev.ev !== 'PostToolUse' || ev.notable);
    if (feedable || notes.length) S.feed.push({ ...ev, account: acct, who, notes });
  }
  S.feed = S.feed.slice(-200);
  for (const P of Object.values(S.projects)) {
    P.pending = P.approvals.filter((x) => x.st === 'pending').length;
    for (const M of P.majors) {
      const live = M.minors.filter((m) => m.st !== 'dropped');
      M.total = live.length; M.done = live.filter((m) => m.st === 'done').length;
    }
  }
  return S;
}

function state() { return reduce(readEvents()); }

// 짧은 텍스트 요약(모델에 돌려줄 때 토큰 아끼기용)
const MARK = { wait: '·', doing: '▶', done: '✓', blocked: '✖', approval: '?', dropped: '-' };
function summary(P, verbose) {
  if (!P) return '없음';
  const lines = [`[${P.id}] 승인대기 ${P.pending}` + (P.cur ? ` 현재 ${P.cur}` : '')];
  for (const M of P.majors) {
    lines.push(`${MARK[M.st] || M.st} ${M.id} ${M.title} ${M.done}/${M.total}${M.grew ? ` (+${M.grew})` : ''}`);
    if (verbose || M.st === 'doing' || M.st === 'blocked')
      for (const m of M.minors) if (m.st !== 'dropped') lines.push(`  ${MARK[m.st]} ${m.id} ${m.title}${m.note && m.st === 'blocked' ? ' — ' + m.note : ''}`);
  }
  for (const a of P.approvals) if (a.st === 'pending') lines.push(`? ${a.id} ${a.text}${a.majors ? ': ' + a.majors.join(' | ') : ''}`);
  return lines.join('\n');
}

// ---------- 진행판 주소 ----------
// 진행판을 맡은 프로세스가 <home>/board-<pc>.json 에 {port, pid}를 적는다. 그 프로세스가 죽었으면 없는 것으로 본다.
const BOARD = path.join(HOME, `board-${PC}.json`);
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
function boardPort() {
  const b = readJson(BOARD);
  return b.port && b.pid && alive(b.pid) ? b.port : null;
}
function writeBoard(port) { fs.mkdirSync(HOME, { recursive: true }); fs.writeFileSync(BOARD, JSON.stringify({ port, pid: process.pid })); }
function clearBoard(port) { try { if (readJson(BOARD).port === port && readJson(BOARD).pid === process.pid) fs.unlinkSync(BOARD); } catch {} }
const boardUrl = () => { const p = boardPort(); return p ? `http://127.0.0.1:${p}` : null; };

module.exports = { HOME, DEFAULT_DIR, CONFIG, PC, PORT, LOG, MARK, shortId, accountName, identity, append, readEvents, etag, reduce, state, summary, boardPort, boardUrl, writeBoard, clearBoard };
