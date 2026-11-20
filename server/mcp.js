#!/usr/bin/env node
// stdio MCP 서버(의존성 없음). 세션마다 한 프로세스가 뜬다.
// 진행판 HTTP는 포트를 먼저 잡은 프로세스 하나가 맡고, 나머지는 주기적으로 재시도한다.
'use strict';
const store = require('./store');
const http = require('./http');

const { TOOLS, call } = require('./tools');

// ---------- JSON-RPC over stdio (줄 단위) ----------
function send(msg) { process.stdout.write(JSON.stringify(msg) + '\n'); }
function handle(msg) {
  const { id, method, params } = msg;
  if (id === undefined) return; // 알림
  try {
    if (method === 'initialize') return send({ jsonrpc: '2.0', id, result: {
      protocolVersion: (params && params.protocolVersion) || '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'ruler', version: '1.1.0' },
      instructions: '두 단계 눈금 진행판. 큰 일은 ruler_plan으로 큰 눈금 제안(사용자 승인) → ruler_split으로 작은 눈금 → ruler_tick. 막히면 blocked, 결정이 필요하면 ruler_ask. project를 생략하면 현재 폴더 이름. ruler_bind는 선택(이름·맡은 큰 눈금). 진행판 주소는 ruler_status 첫 줄(포트는 비어 있는 것을 자동으로 고름).',
    } });
    if (method === 'tools/list') return send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
    if (method === 'tools/call') {
      let text, isError = false;
      try { text = call(params.name, params.arguments || {}); } catch (e) { text = String(e.message || e); isError = true; }
      return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }], isError } });
    }
    if (method === 'ping') return send({ jsonrpc: '2.0', id, result: {} });
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'method not found' } });
  } catch (e) {
    send({ jsonrpc: '2.0', id, error: { code: -32603, message: String(e.message || e) } });
  }
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line) continue;
    try { handle(JSON.parse(line)); } catch { /* 무시 */ }
  }
});
process.stdin.on('end', () => process.exit(0));

if (process.env.RULER_NO_HTTP !== '1') http.serveWithRetry();
