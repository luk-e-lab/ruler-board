#!/usr/bin/env node
// Claude Code 훅 진입점. 모델 토큰 없이 이벤트를 이 PC의 로그 조각에 한 줄씩 쌓는다. 항상 exit 0.
// account·session·pc는 store.append가 채운다. 앱이 세션 id를 환경으로 안 주면 훅 입력의 session_id를 쓴다.
'use strict';
const fs = require('fs');
const path = require('path');

const cut = (s, n) => (s == null ? '' : String(s).replace(/\s+/g, ' ').slice(0, n));

function events(h) {
  const ev = h.hook_event_name;
  const tool = h.tool_name || '';
  const inp = h.tool_input || {};
  if (ev === 'SessionStart') return [{ k: 'hook', ev, info: `${h.source || ''} ${path.basename(h.cwd || '')}`.trim(), cwd: h.cwd || undefined, notable: true }];
  if (ev === 'UserPromptSubmit') return [{ k: 'hook', ev, info: cut(h.prompt, 60), notable: true }];
  if (ev === 'Stop' || ev === 'SubagentStop') return [{ k: 'hook', ev, info: ev === 'Stop' ? '턴 종료' : '서브에이전트 종료', notable: true }];
  if (ev !== 'PostToolUse') return [{ k: 'hook', ev, tool: tool || undefined, notable: true }];

  if (/^mcp__.*ruler.*__ruler_/.test(tool)) return []; // 서버가 이미 기록
  if (tool === 'TodoWrite') return [{ k: 'hplan', items: (inp.todos || []).map((x) => ({ title: cut(x.content, 80), st: x.status })) }];
  if (/update_plan$/.test(tool)) {
    if (Array.isArray(inp.items)) return [{ k: 'hplan', items: inp.items.map((x) => ({ title: cut(x.content, 80), st: x.status })) }];
    return [{ k: 'hplan', advance: !!inp.advance, done: inp.done, start: inp.start }];
  }
  if (/wrap_up$/.test(tool)) return [{ k: 'hplan', wrap: true }];
  if (tool === 'SendMessage') return [{ k: 'handoff', to: cut(inp.to, 60), via: 'message', note: cut(inp.message, 60) }];
  if (/start_session$/.test(tool)) {
    const r = JSON.stringify(h.tool_response || '');
    const id = (/(local_[0-9a-f]{8}-[0-9a-f-]{27})/.exec(r) || [])[1];
    return [{ k: 'handoff', to: id || cut(inp.name || inp.title || 'new-session', 40), via: 'session', note: cut(inp.title, 60) }];
  }
  if (tool === 'Agent' || tool === 'Task') return [{ k: 'handoff', to: 'sub:' + cut(inp.subagent_type || inp.description, 24), via: 'agent', note: cut(inp.description, 60) }];
  return [{ k: 'hook', ev, tool }]; // 마지막 활동 표시만(피드에는 안 띄움)
}

// 웹에서 사용자가 결정한 승인을 요청한 세션에게 한 번만 전달
function deliver(store, ev) {
  if (ev !== 'PostToolUse' && ev !== 'UserPromptSubmit') return;
  const { session, account } = store.identity();
  const S = store.state();
  const here = (S.sessions[session] || {}).project;
  // 서버가 세션 id를 못 받은 경우(proc-…): 같은 계정·같은 프로젝트 세션에 전달
  const mine = (a, P) => a.session === session || (/^proc-/.test(a.session || '') && a.account === account && P.id === here);
  const delivered = new Set(store.readEvents().filter((e) => e.k === 'deliv').map((e) => e.p + '/' + e.id));
  const msgs = [];
  for (const P of Object.values(S.projects)) for (const a of P.approvals) {
    if (a.st !== 'pending' && a.by === 'user(web)' && mine(a, P) && !delivered.has(P.id + '/' + a.id)) {
      store.append({ k: 'deliv', p: P.id, id: a.id });
      msgs.push(`ruler: ${P.id} ${a.id} ${a.st === 'ok' ? '승인됨' : '거절됨'}${a.note ? ' — ' + a.note : ''}`);
    }
  }
  if (msgs.length) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: ev, additionalContext: msgs.join('\n') } }));
}

let store;
try {
  const h = JSON.parse(fs.readFileSync(0, 'utf8'));
  if (!process.env.CLAUDE_CODE_HOST_SESSION_ID && !process.env.CLAUDE_CODE_SESSION_ID && h.session_id) process.env.CLAUDE_CODE_SESSION_ID = h.session_id;
  store = require('../server/store');
  for (const e of events(h)) store.append(e);
  deliver(store, h.hook_event_name);
} catch (e) {
  try { if (store) fs.appendFileSync(path.join(store.HOME, 'hook-errors.log'), new Date().toISOString() + ' ' + (e.stack || e) + '\n'); } catch {}
}
process.exit(0);
