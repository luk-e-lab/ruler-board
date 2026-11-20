// 에이전트 관계도: 누가 누구에게 넘겼나(화살표) + 각 에이전트 마지막 활동.
Ruler.block('agents', {
  title: '에이전트 관계도',
  render({ S, el, esc, ago, chip, show, color, multi, pcTag }) {
    // 12시간 넘게 조용하고 화살표도 없는 세션은 숨김
    const linked = new Set(S.edges.flatMap((e) => [e.from, e.to]));
    const stale = (ag) => !linked.has(ag.name) && Date.now() - new Date(ag.seen || 0).getTime() > 43200000;
    const all = Object.keys(S.agents).filter((n) => n && n !== '?' && show(S.agents[n].account));
    const names = all.filter((n) => !stale(S.agents[n]));
    const hidden = all.length - names.length;
    if (!names.length) { el.innerHTML = '<p class="empty">아직 활동한 에이전트 없음</p>'; return; }
    // 같은 쌍의 넘김은 한 화살표로 묶고 횟수 표시
    const pairs = {};
    for (const e of S.edges) { const k = e.from + '→' + e.to; (pairs[k] = pairs[k] || { ...e, n: 0 }).n++; Object.assign(pairs[k], { note: e.note, t: e.t, via: e.via }); }
    const W = 420, H = Math.max(160, Math.min(300, 70 * Math.ceil(names.length / 2))), cx = W / 2, cy = H / 2, r = Math.min(W, H) / 2 - 34;
    const pos = {};
    names.forEach((n, i) => {
      const a = (i / names.length) * Math.PI * 2 - Math.PI / 2;
      pos[n] = names.length === 1 ? [cx, cy] : [cx + r * 1.5 * Math.cos(a), cy + r * Math.sin(a)];
    });
    const fresh = (t) => t && Date.now() - new Date(t).getTime() < 120000;
    let svg = `<svg viewBox="0 0 ${W} ${H}" width="100%" style="max-height:${H}px" role="img" aria-label="에이전트 관계도">
      <defs><marker id="arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0L10,5L0,10z" fill="var(--mute)"/></marker></defs>`;
    for (const e of Object.values(pairs)) {
      const a = pos[e.from], b = pos[e.to];
      if (!a || !b || a === b) continue;
      const dx = b[0] - a[0], dy = b[1] - a[1], d = Math.hypot(dx, dy) || 1, k = 30 / d;
      // 반대 방향 화살표가 있으면 둘이 겹치지 않게 옆으로 비킴
      const off = pairs[e.to + '→' + e.from] ? 7 : 0, ox = (-dy / d) * off, oy = (dx / d) * off;
      const col = multi && S.accounts[e.account] ? color(e.account) : 'var(--mute)';
      svg += `<line x1="${a[0] + dx * k + ox}" y1="${a[1] + dy * k + oy}" x2="${b[0] - dx * k + ox}" y2="${b[1] - dy * k + oy}" stroke="${col}" stroke-width="1.6" marker-end="url(#arr)"><title>${esc(e.from)} → ${esc(e.to)} ×${e.n} (${esc(e.via)}) ${esc(e.note)}</title></line>`;
      if (e.n > 1) svg += `<text x="${(a[0] + b[0]) / 2 + ox * 2.2}" y="${(a[1] + b[1]) / 2 + oy * 2.2 + 4}" font-size="11" fill="${col}" text-anchor="middle">×${e.n}</text>`;
    }
    for (const n of names) {
      const [x, y] = pos[n], ag = S.agents[n];
      svg += `<g><circle cx="${x}" cy="${y}" r="26" fill="var(--card)" stroke="${multi && S.accounts[ag.account] ? color(ag.account) : 'var(--line)'}" stroke-width="${fresh(ag.seen) ? 4 : 2}"/>
        <text x="${x}" y="${y + 4}" font-size="11" fill="var(--ink)" text-anchor="middle">${esc(n.length > 9 ? n.slice(0, 8) + '…' : n)}</text><title>${esc(n)}</title></g>`;
    }
    svg += '</svg>';
    const rows = names.map((n) => S.agents[n]).sort((a, b) => (b.seen || '').localeCompare(a.seen || ''))
      .map((ag) => `<div style="display:flex;gap:8px;font-size:12px;padding:3px 0;border-top:1px solid var(--line)">
        <b style="min-width:80px">${chip(ag.account)} ${esc(ag.name)} ${pcTag(ag.pc)}</b><span style="color:var(--mute);flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(ag.project || '')} ${ag.tool ? '· ' + esc(ag.tool) : ''}</span><span style="color:var(--mute)">${ago(ag.seen)}</span></div>`).join('');
    const legend = S.edges.length ? `<div style="font-size:11px;color:var(--mute);padding:2px 0 6px">화살표 = 메시지·넘김${multi ? ' · 색 = 보낸 계정' : ''} · ×n = 횟수</div>` : '';
    el.innerHTML = svg + legend + rows +(hidden ? `<div style="font-size:11px;color:var(--mute);padding-top:4px">조용한 세션 ${hidden}개 숨김(12시간 넘게 활동 없음)</div>` : '');
  },
});
