// MCP 도구 정의와 실행(명령줄 cli.js도 같이 씀). 계약: schema/CONTRACT.md 4번
'use strict';
const path = require('path');
const store = require('./store');
const { MARK } = store;

const mem = { agent: process.env.RULER_AGENT || null, project: null };

const S = (props, req) => ({ type: 'object', properties: props, required: req || [] });
const str = (d) => ({ type: 'string', description: d });
const arr = (d) => ({ type: 'array', items: { type: 'string' }, description: d });
const common = { project: str('프로젝트 id(생략 시 이 세션이 마지막으로 쓴 것, 없으면 현재 폴더 이름)'), agent: str('내 표시 이름(한 번 주면 기억)') };

const TOOLS = [
  { name: 'ruler_bind', description: '선택. 이 세션의 표시 이름·프로젝트·맡은 큰 눈금을 연결(작업 목록이 그 큰 눈금의 작은 눈금으로 동기화됨).',
    inputSchema: S({ ...common, major: str('맡은 큰 눈금 M1 또는 제목') }) },
  { name: 'ruler_plan', description: '큰 눈금(3~7개) 제안/변경. 사용자 승인 후 반영됨.',
    inputSchema: S({ ...common, majors: arr('큰 눈금 제목 순서대로'), note: str('제안 이유') }, ['majors']) },
  { name: 'ruler_split', description: '큰 눈금 아래 작은 눈금(30~60분 단위) 추가/제외. 재량.',
    inputSchema: S({ ...common, major: str('M1 또는 제목'), add: arr('추가할 작은 눈금'), drop: arr('제외할 id') }, ['major']) },
  { name: 'ruler_tick', description: '눈금 상태 변경. st: wait|doing|done|blocked. doing이면 같은 프로젝트에서 일하는 다른 세션을 답에 붙여 줌.',
    inputSchema: S({ ...common, id: str('M1 또는 M1.2'), st: { type: 'string', enum: ['wait', 'doing', 'done', 'blocked'] }, note: str('막힘 사유 등') }, ['id', 'st']) },
  { name: 'ruler_ask', description: '사용자 승인 요청(대기열에 올림). target 눈금은 승인대기 표시.',
    inputSchema: S({ ...common, text: str('무엇을 승인받나'), target: str('관련 눈금 id') }, ['text']) },
  { name: 'ruler_decide', description: '사용자가 채팅에서 답한 승인 결과 기록. 사용자가 실제로 답했을 때만.',
    inputSchema: S({ ...common, id: str('A1 등'), ok: { type: 'boolean' }, note: str('메모') }, ['id', 'ok']) },
  { name: 'ruler_handoff', description: '다른 에이전트·세션에게 일을 넘김(관계도 화살표).',
    inputSchema: S({ ...common, to: str('받는 쪽 이름 또는 세션 id'), note: str('무엇을 넘기나') }, ['to']) },
  { name: 'ruler_status', description: '진행 요약(짧은 텍스트). all=true면 작은 눈금 전부. account(id 또는 별명)를 주면 그 계정 것만.',
    inputSchema: S({ project: str('프로젝트 id'), all: { type: 'boolean' }, account: str('계정 id 또는 별명') }) },
];

// 같은 세션이 마지막으로 쓴 프로젝트
function mySessionProject() {
  const { session } = store.identity();
  const evs = store.readEvents();
  for (let i = evs.length - 1; i >= 0; i--) if (evs[i].p && evs[i].session === session) return evs[i].p;
  return null;
}
const folderProject = () => path.basename(process.env.CLAUDE_PROJECT_DIR || process.cwd()) || 'default';
const project = (args) => (mem.project = args.project || mem.project || mySessionProject() || folderProject());

// 계정 id 또는 별명 → id
function resolveAccount(st, q) {
  const k = String(q).toLowerCase();
  const hit = Object.values(st.accounts).find((A) => A.id.toLowerCase() === k || A.name.toLowerCase() === k);
  return hit ? hit.id : String(q);
}

// 한 계정이 맡은 눈금(마지막으로 만진 계정 기준)과 최근 활동
function accountSummary(st, account, projectId, all) {
  const lines = [];
  for (const P of Object.values(st.projects)) {
    if (projectId && P.id !== projectId) continue;
    const rows = [];
    for (const M of P.majors) {
      const mine = M.minors.filter((m) => m.account === account && m.st !== 'dropped' && (all || m.st !== 'done'));
      if (M.account === account || mine.length) rows.push(`${MARK[M.st] || M.st} ${M.id} ${M.title} ${M.done}/${M.total}`);
      for (const m of mine) rows.push(`  ${MARK[m.st]} ${m.id} ${m.title}${m.note && m.st === 'blocked' ? ' — ' + m.note : ''}`);
    }
    for (const a of P.approvals) if (a.st === 'pending' && a.account === account) rows.push(`? ${a.id} ${a.text}`);
    if (rows.length) lines.push(`[${P.id}]`, ...rows);
  }
  const ags = Object.values(st.agents).filter((g) => g.account === account).sort((x, y) => (y.seen || '').localeCompare(x.seen || ''));
  if (ags[0]) lines.push(`최근 활동: ${ags[0].name} ${ags[0].seen}${ags[0].tool ? ' (' + ags[0].tool + ')' : ''}`);
  const name = store.accountName(account);
  return lines.length ? `${name}:\n` + lines.join('\n') : `${name}: 맡은 눈금·활동 없음`;
}

// 같은 프로젝트에서 다른 세션(다른 계정 포함)이 진행 중인 작은 눈금
function othersHere(st, session, P) {
  const multi = Object.keys(st.accounts).length > 1;
  const rows = [];
  for (const M of P.majors) for (const m of M.minors)
    if (m.session && m.session !== session && (m.st === 'doing' || m.st === 'blocked'))
      rows.push(`${MARK[m.st]} ${m.id} ${m.title} (${m.agent}${multi ? '·' + store.accountName(m.account) : ''})`);
  return '\n여기서 일하는 다른 세션: ' + (rows.length ? rows.slice(0, 2).join(' / ') + (rows.length > 2 ? ` 외 ${rows.length - 2}` : '') : '없음');
}

function call(name, args) {
  args = args || {};
  if (args.agent) mem.agent = args.agent;
  if (name === 'ruler_status') {
    const st = store.state();
    const url = store.boardUrl();
    const head = url ? `진행판 ${url}\n` : '진행판 꺼짐(MCP 세션이 뜨면 켜짐)\n';
    if (args.account) return head + accountSummary(st, resolveAccount(st, args.account), args.project || null, args.all);
    const id = args.project || mem.project || mySessionProject() || folderProject();
    if (st.projects[id]) return head + store.summary(st.projects[id], args.all);
    return head + (Object.values(st.projects).map((P) => store.summary(P)).join('\n\n') || '프로젝트 없음');
  }

  const p = project(args);
  const ev = { p, a: mem.agent || undefined };
  if (name === 'ruler_bind') Object.assign(ev, { k: 'bind', major: args.major, cwd: process.env.CLAUDE_PROJECT_DIR || process.cwd() });
  else if (name === 'ruler_plan') Object.assign(ev, { k: 'plan', majors: args.majors, note: args.note });
  else if (name === 'ruler_split') Object.assign(ev, { k: 'split', major: args.major, add: args.add || [], drop: args.drop || [] });
  else if (name === 'ruler_tick') Object.assign(ev, { k: 'tick', id: args.id, st: args.st, note: args.note });
  else if (name === 'ruler_ask') Object.assign(ev, { k: 'ask', text: args.text, target: args.target });
  else if (name === 'ruler_decide') Object.assign(ev, { k: 'decide', id: args.id, ok: !!args.ok, note: args.note, a: mem.agent || 'user' });
  else if (name === 'ruler_handoff') Object.assign(ev, { k: 'handoff', to: args.to, note: args.note, via: 'ruler' });
  else throw new Error('모르는 도구 ' + name);
  store.append(ev);
  if (name === 'ruler_bind') return `ok ${p}${ev.major ? ' ' + ev.major : ''} (${store.accountName(ev.account)}·${ev.session})`;
  const st = store.state();
  const P = st.projects[p];
  // 답은 짧게: 바뀐 것 위주
  if (name === 'ruler_plan' || name === 'ruler_ask') return `${P.approvals[P.approvals.length - 1].id} 승인대기 (${p})`;
  if (name === 'ruler_split') { const M = P.majors.find((x) => x.id === args.major || x.title === args.major); return M ? `${M.id}: ` + M.minors.filter((m) => m.st !== 'dropped').map((m) => m.id).join(',') : '큰 눈금 없음(승인 전?)'; }
  if (name === 'ruler_tick') {
    const M = P.majors.find((x) => args.id === x.id || args.id.startsWith(x.id + '.'));
    if (!M) return '눈금 없음';
    let out = `ok ${M.id} ${M.done}/${M.total} ${M.st}`;
    if (args.st === 'doing' && args.id.includes('.')) out += othersHere(st, ev.session, P);
    return out;
  }
  return 'ok';
}

module.exports = { TOOLS, call, mem };
