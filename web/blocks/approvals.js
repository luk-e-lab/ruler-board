// 승인 대기열: 모든 프로젝트의 대기 중 승인 + 최근 결정 몇 개. 대기 건이 있으면 블록 전체를 주황으로 강조.
Ruler.block('approvals', {
  title: '승인 대기열',
  render({ S, el, esc, ago, decide, chip, show }) {
    const all = [];
    for (const P of Object.values(S.projects)) for (const a of P.approvals) if (show(a.account)) all.push({ ...a, p: P.id });
    const pend = all.filter((a) => a.st === 'pending').sort((a, b) => a.t.localeCompare(b.t));
    const recent = all.filter((a) => a.st !== 'pending').sort((a, b) => (b.decidedAt || '').localeCompare(a.decidedAt || '')).slice(0, 3);
    const box = el.parentElement;
    box.classList.toggle('alert', pend.length > 0);
    box.id = 'approvals';
    box.querySelector('h2').textContent = pend.length ? `승인 대기 ${pend.length}건 — 결정이 필요합니다` : '승인 대기열';
    const pendItem = (a) => `<div class="ap-item">
      <div class="ap-text">${chip(a.account)} <b>${esc(a.p)} ${esc(a.id)}</b> ${esc(a.text)} ${a.target ? '<span style="color:var(--mute)">→ ' + esc(a.target) + '</span>' : ''}</div>
      ${a.majors ? `<ol style="margin:4px 0 0 18px;padding:0">${a.majors.map((t) => `<li>${esc(t)}</li>`).join('')}</ol>` : ''}
      <div class="ap-meta">${esc(a.agent)} · ${ago(a.t)}</div>
      <div class="ap-btns"><button class="ok big" data-p="${esc(a.p)}" data-id="${esc(a.id)}" data-ok="1">승인</button><button class="big" data-p="${esc(a.p)}" data-id="${esc(a.id)}" data-ok="0">거절</button></div>
    </div>`;
    const doneItem = (a) => `<div style="padding:6px 0;border-top:1px solid var(--line);font-size:13px">
      <span class="pill st-${a.st === 'ok' ? 'done' : 'blocked'}">${a.st === 'ok' ? '승인' : '거절'}</span>
      ${chip(a.account)} <b>${esc(a.p)} ${esc(a.id)}</b> ${esc(a.text)}
      <div style="font-size:11px;color:var(--mute)">${esc(a.agent)} · ${ago(a.decidedAt || a.t)}${a.by ? ' · 결정 ' + esc(a.by) + (a.note ? ': ' + esc(a.note) : '') : ''}</div></div>`;
    el.innerHTML = (pend.length ? pend.map(pendItem).join('') : '<p class="empty">대기 중인 승인 없음</p>')
      + (recent.length ? '<div style="margin-top:10px;font-size:12px;color:var(--mute)">최근 결정</div>' + recent.map(doneItem).join('') : '');
    el.querySelectorAll('button[data-id]').forEach((b) => { b.onclick = () => decide(b.dataset.p, b.dataset.id, b.dataset.ok === '1'); });
  },
});
