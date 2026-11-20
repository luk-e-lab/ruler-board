// 진행률: 전체 %를 크게, 큰 눈금마다 막대 하나와 %. 작은 눈금은 줄을 눌러 펼친다.
// 큰 눈금 % = 끝난 작은 눈금 ÷ 작은 눈금(제외 빼고). 전체 % = 큰 눈금 %의 평균(큰 눈금마다 같은 몫).
(() => {
  const open = new Set(); // 펼친 큰 눈금(다시 그려도 유지)

  const pctOf = (M) => (M.st === 'done' ? 100 : M.total ? Math.round((M.done / M.total) * 100) : 0);
  // 막대 색 = 가장 급한 상태: 승인대기 > 막힘 > 진행 > 완료 > 대기
  const tone = (M) => {
    const live = M.minors.filter((m) => m.st !== 'dropped');
    if (M.st === 'approval' || live.some((m) => m.st === 'approval')) return 'approval';
    if (M.st === 'blocked' || live.some((m) => m.st === 'blocked')) return 'blocked';
    if (M.st === 'done') return 'done';
    if (M.st === 'doing' || live.some((m) => m.st === 'doing' || m.st === 'done')) return 'doing';
    return 'wait';
  };

  const CSS = `
  .pg-top { display:flex; align-items:baseline; gap:14px; flex-wrap:wrap; margin-bottom:6px; }
  .pg-big { font-size:44px; font-weight:700; line-height:1; letter-spacing:-.02em; }
  .pg-sum { color:var(--mute); font-size:13px; }
  .pg-bar { height:12px; border-radius:6px; background:var(--wait); overflow:hidden; }
  .pg-bar > i { display:block; height:100%; border-radius:6px; transition:width .4s; }
  .pg-bar.total { height:16px; margin-bottom:16px; }
  .t-done > i { background:var(--done); } .t-doing > i { background:var(--doing); } .t-wait > i { background:var(--mute); }
  .t-blocked > i { background:var(--blocked); } .t-approval > i { background:var(--approval); }
  .pg-row { border-top:1px solid var(--line); }
  .pg-row > summary { list-style:none; cursor:pointer; display:grid; grid-template-columns:minmax(140px,260px) 1fr 56px; gap:12px; align-items:center; padding:9px 0; }
  .pg-row > summary::-webkit-details-marker { display:none; }
  .pg-row > summary:hover .pg-name b { text-decoration:underline; }
  .pg-name { min-width:0; font-size:14px; }
  .pg-name .t { display:block; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .pg-name .t::before { content:"▸"; display:inline-block; width:14px; color:var(--mute); transition:transform .15s; }
  .pg-row[open] .pg-name .t::before { transform:rotate(90deg); }
  .pg-meta { font-size:11px; color:var(--mute); padding-left:14px; }
  .pg-pct { font-size:18px; font-weight:700; text-align:right; font-variant-numeric:tabular-nums; }
  .pg-hot { grid-column:1 / -1; font-size:12px; padding-left:14px; margin-top:-4px; }
  .pg-hot div { white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .grew { color:var(--approval); font-weight:600; }
  .pg-minors { margin:0 0 10px 14px; padding:0; list-style:none; font-size:13px; }
  .pg-minors li { display:flex; gap:8px; align-items:baseline; padding:2px 0; }
  .pg-minors .id { color:var(--mute); min-width:44px; font-variant-numeric:tabular-nums; }
  .pg-minors .note { color:var(--mute); font-size:12px; }
  .ghost { border:1px dashed var(--approval); border-radius:8px; padding:8px 10px; margin-top:10px; font-size:13px; }
  @media (max-width:520px){ .pg-row > summary { grid-template-columns:1fr 48px; } .pg-row > summary .pg-bar { grid-column:1 / -1; grid-row:2; } .pg-big { font-size:36px; } }`;

  Ruler.block('ruler', {
    title: '진행률',
    wide: true,
    render({ P, el, esc, ago, LABEL, chip, show }) {
      if (!document.getElementById('css-ruler')) {
        const s = document.createElement('style'); s.id = 'css-ruler'; s.textContent = CSS; document.head.appendChild(s);
      }
      if (!P) { el.innerHTML = '<p class="empty">프로젝트 없음. ruler_plan으로 큰 눈금을 제안하세요.</p>'; return; }
      const majors = P.majors;
      let h = '';
      if (majors.length) {
        const total = Math.round(majors.reduce((n, M) => n + pctOf(M), 0) / majors.length);
        const doneM = majors.filter((M) => M.st === 'done').length;
        const minors = majors.flatMap((M) => M.minors.filter((m) => m.st !== 'dropped'));
        const doneN = minors.filter((m) => m.st === 'done').length;
        const stuck = minors.filter((m) => m.st === 'blocked').length;
        const totalTone = total === 100 ? 'done' : majors.some((M) => tone(M) === 'approval') ? 'approval' : stuck ? 'blocked' : 'doing';
        h += `<div class="pg-top"><span class="pg-big">${total}%</span>
          <span class="pg-sum">큰 눈금 ${doneM}/${majors.length} 완료 · 작은 눈금 ${doneN}/${minors.length}${stuck ? ` · <span class="st-blocked">막힘 ${stuck}</span>` : ''}${P.pending ? ` · <span class="st-approval">승인 대기 ${P.pending}</span>` : ''}</span></div>
          <div class="pg-bar total t-${totalTone}"><i style="width:${total}%"></i></div>`;
        for (const M of majors) {
          const pct = pctOf(M), t = tone(M);
          const live = M.minors.filter((m) => m.st !== 'dropped');
          const hot = live.filter((m) => m.st === 'blocked' || m.st === 'approval');
          const dim = M.account && M.account !== '?' && !show(M.account) ? ' style="opacity:.35"' : '';
          h += `<details class="pg-row" data-id="${esc(M.id)}"${open.has(P.id + '/' + M.id) ? ' open' : ''}${dim}>
            <summary>
              <div class="pg-name"><span class="t"><b>${esc(M.id)}</b> ${esc(M.title)}</span>
                <span class="pg-meta"><span class="st-${t}">${LABEL[t]}</span> · ${M.done}/${M.total}${M.grew ? ` <span class="grew" title="처음 쪼갠 뒤 늘어난 작은 눈금">+${M.grew}</span>` : ''} ${chip(M.account)} ${M.agent ? esc(M.agent) : ''}</span></div>
              <div class="pg-bar t-${t}"><i style="width:${pct}%"></i></div>
              <div class="pg-pct st-${t}">${pct}%</div>
              ${hot.length ? `<div class="pg-hot">${hot.map((m) => `<div><span class="st-${m.st}">${LABEL[m.st]}</span> ${esc(m.id)} ${esc(m.title)}${m.note ? ' — ' + esc(m.note) : ''} <span style="color:var(--mute)">${ago(m.at)}</span></div>`).join('')}</div>` : ''}
            </summary>
            ${live.length ? `<ul class="pg-minors">${live.map((m) => `<li><span class="id">${esc(m.id)}</span><span class="pill st-${m.st}">${LABEL[m.st]}</span> ${chip(m.account)} <span>${esc(m.title)}</span>${m.note ? ` <span class="note">— ${esc(m.note)}</span>` : ''}${m.auto ? ' <span class="note" title="작업 목록에서 훅이 자동으로 만든 눈금">(자동)</span>' : ''}</li>`).join('')}</ul>` : '<p class="empty" style="margin:0 0 10px 14px;font-size:12px">작은 눈금 아직 없음</p>'}
          </details>`;
        }
      } else h += '<p class="empty">큰 눈금 합의 전</p>';
      const prop = P.approvals.find((a) => a.id === P.proposed && a.st === 'pending');
      if (prop) h += `<div class="ghost"><b>제안된 큰 눈금 (${esc(prop.id)})</b> — ${prop.majors.map((t, i) => `${i + 1}. ${esc(t)}`).join(' · ')}</div>`;
      el.innerHTML = h;
      el.querySelectorAll('details.pg-row').forEach((d) => {
        d.ontoggle = () => { const k = P.id + '/' + d.dataset.id; if (d.open) open.add(k); else open.delete(k); };
      });
    },
  });
})();
