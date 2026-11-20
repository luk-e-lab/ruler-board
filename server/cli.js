#!/usr/bin/env node
// 명령줄: node server/cli.js <도구> '<JSON 인자>'   예) node server/cli.js ruler_status '{"all":true}'
'use strict';
const { call } = require('./tools');
const [name, json] = process.argv.slice(2);
if (!name) { console.log('사용: node server/cli.js ruler_bind|ruler_plan|ruler_split|ruler_tick|ruler_ask|ruler_decide|ruler_handoff|ruler_status \'{...}\''); process.exit(0); }
try { console.log(call(name.startsWith('ruler_') ? name : 'ruler_' + name, JSON.parse(json || '{}'))); }
catch (e) { console.error(e.message); process.exit(1); }
