// 블록 조립기: layout.json에 적힌 블록 파일(blocks/<이름>.js)을 차례로 불러 붙인다.
// 블록 파일은 Ruler.block('이름', { title, wide, render(ctx) }) 하나만 부르면 된다.
'use strict';
window.Ruler = (() => {
  const defs = {};
  const els = {};
  let S = null, layout = null, etag = null, selected = null, lastNoteT = null;
  let acct = ''; try { acct = localStorage.getItem('ruler.acct') || ''; } catch {}

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const ago = (t) => {
    if (!t) return '';
    const s = Math.max(0, (Date.now() - new Date(t).getTime()) / 1000);
    if (s < 60) return Math.floor(s) + '초 전';
    if (s < 3600) return Math.floor(s / 60) + '분 전';
    if (s < 86400) return Math.floor(s / 3600) + '시간 전';
    return Math.floor(s / 86400) + '일 전';
  };
  // 계정 칩·필터 — 계정이 2개 이상일 때만 보인다. 색은 계정 id에서 정함
  const multi = () => S && Object.keys(S.accounts).length > 1;
  const color = (a) => { let h = 0; for (const c of String(a)) h = (h * 31 + c.charCodeAt(0)) % 360; return `hsl(${h} 55% 48%)`; };
  const acctName = (a) => (S.accounts[a] || {}).name || a;
  const chip = (a) => (multi() && S.accounts[a] ? `<span class="acct" style="background:${color(a)}" title="계정">${esc(acctName(a))}</span>` : '');
  const show = (a) => !acct || !multi() || a === acct;
  // PC 이름 — PC가 2대 이상일 때만
  const pcTag = (pc) => (S.pcs.length > 1 && pc ? `<span class="pc">${esc(pc)}</span>` : '');
  const LABEL = { wait: '대기', doing: '진행', done: '완료', blocked: '막힘', approval: '승인대기', dropped: '제외' };

  async function decide(project, id, ok) {
    const note = ok ? '' : (prompt('거절 사유(선택)') || '');
    await fetch('/api/decide', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Ruler': '1' }, body: JSON.stringify({ project, id, ok, note }) });
    poll(true);
  }

  function block(name, def) { defs[name] = def; }

  function loadScript(src) {
    return new Promise((res) => { const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = res; document.head.appendChild(s); });
  }

  function render() {
    if (!S) return;
    const sel = document.getElementById('project');
    const ids = Object.values(S.projects).sort((a, b) => (b.updated || '').localeCompare(a.updated || '')).map((p) => p.id);
    if (!selected || !S.projects[selected]) selected = ids[0] || null;
    sel.innerHTML = ids.map((id) => `<option ${id === selected ? 'selected' : ''}>${esc(id)}</option>`).join('');
    const P = selected ? S.projects[selected] : null;
    const as = document.getElementById('acct');
    as.hidden = !multi();
    const opts = '<option value="">전체 계정</option>' + Object.values(S.accounts).map((A) => `<option value="${esc(A.id)}"${A.id === acct ? ' selected' : ''}>${esc(A.name)}</option>`).join('');
    if (as.innerHTML !== opts) as.innerHTML = opts;
    const pending = Object.values(S.projects).reduce((n, p) => n + p.pending, 0);
    document.title = (pending ? `(${pending}) ` : '') + 'Ruler Board';
    const badge = document.getElementById('pending');
    badge.hidden = !pending;
    badge.textContent = `승인 대기 ${pending}`;
    for (const name of layout.blocks) {
      const d = defs[name], box = els[name];
      if (!d || !box) continue;
      try { d.render({ S, P, el: box.body, esc, ago, LABEL, decide, project: selected, acct, chip, show, color, multi: multi(), pcTag }); }
      catch (e) { box.body.innerHTML = `<p class="err">블록 오류: ${esc(e.message)}</p>`; }
    }
    notify();
  }

  // 알림은 큰 눈금 완료·막힘·승인 필요일 때만
  function notify() {
    const notes = [];
    for (const ev of S.feed) for (const n of ev.notes || []) notes.push({ ...n, t: ev.t });
    if (lastNoteT === null) { lastNoteT = notes.length ? notes[notes.length - 1].t : ''; return; }
    const fresh = notes.filter((n) => n.t > lastNoteT);
    if (!fresh.length) return;
    lastNoteT = fresh[fresh.length - 1].t;
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    for (const n of fresh) {
      const title = { major_done: '큰 눈금 완료', blocked: '막힘', approval: '승인 필요' }[n.kind];
      try { new Notification(`${title} · ${n.p}`, { body: `${n.id} ${n.title || n.text || ''} ${n.note || ''}` }); } catch {}
    }
  }

  async function poll(force) {
    try {
      const r = await fetch('/api/state', { headers: !force && etag ? { 'If-None-Match': etag } : {} });
      document.getElementById('live').textContent = '실시간 ' + new Date().toLocaleTimeString();
      document.getElementById('live').className = 'live ok';
      if (r.status === 200) { etag = r.headers.get('ETag'); S = await r.json(); render(); }
      else if (r.status === 304) render(); // '몇 분 전' 갱신
    } catch {
      document.getElementById('live').textContent = '서버 끊김';
      document.getElementById('live').className = 'live bad';
    }
  }

  async function start() {
    layout = await (await fetch('layout.json', { cache: 'no-store' })).json();
    const main = document.getElementById('blocks');
    for (const name of layout.blocks) await loadScript(`blocks/${name}.js`);
    for (const name of layout.blocks) {
      const d = defs[name];
      const sec = document.createElement('section');
      sec.className = 'block' + (d && d.wide ? ' wide' : '');
      sec.innerHTML = `<h2>${esc(d ? d.title : name)}</h2><div class="body">${d ? '' : '블록 파일 없음: blocks/' + esc(name) + '.js'}</div>`;
      main.appendChild(sec);
      els[name] = { body: sec.querySelector('.body') };
    }
    document.getElementById('project').onchange = (e) => { selected = e.target.value; render(); };
    const as = document.getElementById('acct');
    as.onchange = (e) => { acct = e.target.value; try { localStorage.setItem('ruler.acct', acct); } catch {} render(); };
    // 테마: 자동(시스템 설정) → 라이트 → 다크. 브라우저에 기억
    const THEMES = { '': '◐ 자동', light: '☀ 라이트', dark: '☾ 다크' };
    let theme = ''; try { theme = localStorage.getItem('ruler.theme') || ''; } catch {}
    const tb = document.getElementById('theme');
    const applyTheme = () => {
      if (theme) document.documentElement.dataset.theme = theme; else delete document.documentElement.dataset.theme;
      tb.textContent = THEMES[theme];
    };
    applyTheme();
    tb.onclick = () => {
      theme = theme === '' ? 'light' : theme === 'light' ? 'dark' : '';
      try { localStorage.setItem('ruler.theme', theme); } catch {}
      applyTheme();
    };
    if ('Notification' in window && Notification.permission === 'default') {
      document.body.addEventListener('click', () => Notification.requestPermission(), { once: true });
    }
    await poll(true);
    setInterval(poll, layout.poll_ms || 1500);
  }

  document.addEventListener('DOMContentLoaded', start);
  return { block };
})();
