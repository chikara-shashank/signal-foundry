import { escape as esc } from './dashboard-format.js';

const label=s=>String(s??'unknown').replaceAll('_',' ');
const when=t=>new Date(t).toLocaleString('en-US',{timeZone:'America/New_York',month:'short',day:'numeric',hour:'2-digit',minute:'2-digit',timeZoneName:'short'});
const sourceLink=s=>{
  try{const u=new URL(s.url);if(u.protocol==='https:')return `<a href="${esc(u.href)}" target="_blank" rel="noopener noreferrer">${esc(s.headline)}</a>`;}catch{}
  return esc(s.headline);
};
export function researchContextHtml(context) {
  if(!context)return '';
  return `<div class="panel-title"><div><span class="eyebrow">SOURCED RESEARCH · SHADOW</span><h3>Thesis &amp; opposing evidence</h3></div><span class="pill">${esc(context.mode==='off'?'OFF':context.busy?'REVIEWING':'OBSERVING')}</span></div>
    <p class="muted">${esc(context.note)} ${Number(context.callsToday)} / ${Number(context.dailyLimit)} model calls today. ${context.reason?esc(label(context.reason)):''}</p>
    <div class="research-theses">${context.rows.length?context.rows.map(r=>`<article class="research-thesis">
      <div class="panel-title"><strong>${esc(r.symbol)}</strong><span class="${r.current?'':'negative'}">${r.current?'Current context':'Expired or invalidated'}</span></div>
      <p>${esc(r.thesis.statement)}</p><dl><dt>Case</dt><dd>${esc(label(r.thesis.verdict))}</dd><dt>Critic</dt><dd>${r.critic?esc(label(r.critic.verdict)):'Pending — no completed challenge'}</dd>
      <dt>Available</dt><dd>${esc(when(r.availableAt))}</dd><dt>Expires</dt><dd>${esc(when(r.expiresAt))}</dd><dt>Recorded cost</dt><dd>$${Number(r.costUsd).toFixed(6)}</dd></dl>
      <details><summary>Evidence, objections &amp; invalidation</summary><ul>${r.evidence.sources.map(s=>`<li>${sourceLink(s)}<br><small>${esc(s.source)} · published ${esc(when(s.publishedAt))} · observed ${esc(when(s.observedAt))}<br>${r.thesis.support.includes(s.id)?'Supporting source':r.thesis.contrary.includes(s.id)?'Contrary source':'Unconfirmed or irrelevant'}${r.critic?.objections.find(o=>o.id===s.id)?' · '+esc(label(r.critic.objections.find(o=>o.id===s.id).value)):''}</small></li>`).join('')}</ul>
      <p><strong>Invalidates on:</strong> ${esc(r.thesis.invalidation.join('; '))}.</p><p><strong>Unknown:</strong> ${esc(r.evidence.unknowns.join('; '))}.</p><small>Evidence ${esc(r.evidence.id.slice(0,12))} · ${esc(r.model)} · ${esc(r.version)}</small></details></article>`).join(''):
      '<p class="empty">No completed research yet. Fresh news, a shortlisted equity and a configured model are required. Research does not place orders.</p>'}</div>`;
}
