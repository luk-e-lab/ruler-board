// 최근 이벤트 흐름. 훅이 기록한 것(🪝)과 모델이 도구로 기록한 것을 구분해 보여 준다.
Ruler.block('feed', {
  title: '최근 이벤트',
  wide: true,
  render({ S, el, esc, ago, LABEL, chip, show, pcTag }) {
    const say = (e) => {
      switch (e.k) {
        case 'plan': return `큰 눈금 제안: ${(e.majors || []).join(' | ')}`;
        case 'ask': return `승인 요청: ${e.text}${e.target ? ' → ' + e.target : ''}`;
        case 'decide': return `${e.id} ${e.ok ? '승인' : '거절'}${e.note ? ' — ' + e.note : ''}`;
        case 'split': return `${e.major} 쪼갬 +${(e.add || []).length}${(e.drop || []).length ? ' −' + e.drop.length : ''}: ${(e.add || []).join(', ')}`;
        case 'tick': return `${e.id} → ${LABEL[e.st] || e.st}${e.note ? ' — ' + e.note : ''}`;
        case 'handoff': return `${e.from || e.who} → ${e.to} 넘김 (${e.via || ''})${e.note ? ' — ' + e.note : ''}`;
        case 'hplan': return '작업 목록 ' + (e.items ? `갱신 (${e.items.length}개)` : e.advance ? '다음 단계' : e.wrap ? '마무리' : '변경');
        case 'deliv': return `${e.id} 결정을 에이전트에게 전달(훅)`;
        case 'hook': return `${e.ev}${e.tool ? ' ' + e.tool : ''}${e.info ? ' — ' + e.info : ''}`;
        default: return e.k;
      }
    };
    const items = S.feed.filter((e) => show(e.account)).slice(-40).reverse();
    if (!items.length) { el.innerHTML = '<p class="empty">이벤트 없음</p>'; return; }
    el.innerHTML = '<div style="max-height:360px;overflow:auto">' + items.map((e) => {
      const hook = ['hook', 'hplan', 'deliv'].includes(e.k) || (e.k === 'handoff' && e.via !== 'ruler');
      const hot = (e.notes || []).map((n) => `<span class="pill st-${n.kind === 'major_done' ? 'done' : n.kind}">${{ major_done: '큰 눈금 완료', blocked: '막힘', approval: '승인 필요' }[n.kind]}</span>`).join(' ');
      return `<div style="display:flex;gap:8px;font-size:12px;padding:3px 0;border-top:1px solid var(--line)">
        <span style="color:var(--mute);min-width:52px">${ago(e.t)}</span>
        <span class="src ${hook ? 'hook' : 'tool'}" title="${hook ? '훅이 기록(모델 토큰 0)' : '모델이 ruler 도구로 기록'}">${hook ? '훅' : '도구'}</span>
        <b style="min-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:200px">${chip(e.account)} ${esc(e.who || '')} ${pcTag(e.pc)}</b>
        <span style="flex:1;min-width:0;overflow-wrap:anywhere">${e.p ? '<span style="color:var(--mute)">' + esc(e.p) + '</span> ' : ''}${esc(say(e))} ${hot}</span></div>`;
    }).join('') + '</div>';
  },
});
