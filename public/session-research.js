import { escape as esc } from './dashboard-format.js';
const label=x=>String(x??'unavailable').replaceAll('_',' ');
const money=x=>Number.isFinite(x)?x.toLocaleString('en-US',{style:'currency',currency:'USD',maximumFractionDigits:2}):'—';
const pct=x=>Number.isFinite(x)?(x*100).toFixed(1)+'%':'—';
const time=x=>x?new Date(x).toLocaleString('en-US',{timeZone:'America/New_York',month:'short',day:'numeric',hour:'2-digit',minute:'2-digit',timeZoneName:'short'}):'not yet';
function link(a) { try {const u=new URL(a.url);if(u.protocol==='https:')return `<a href="${esc(u.href)}" target="_blank" rel="noopener noreferrer">${esc(a.headline)}</a>`;}catch{} return esc(a.headline); }
export class SessionResearchView {
  constructor(api) {
    this.api=api;this.last=0;this.sequence=0;
    this.section=document.createElement('section');this.section.className='panel session-research';this.section.id='session-research-panel';
    this.section.innerHTML='<div class="panel-title"><div><span class="eyebrow">MARKET HOURS &amp; RESEARCH</span><h2>Sessions &amp; tomorrow’s watchlist</h2></div><span class="pill" data-session-state>CONNECTING</span></div><p data-session-message class="muted" role="status"></p><div data-session-content></div>';
    document.getElementById('discovery-panel').before(this.section);
  }
  async refresh() {
    if(Date.now()-this.last<10000)return;
    this.last=Date.now();const sequence=++this.sequence;
    try {const data=await this.api('/api/session-research');if(sequence===this.sequence)this.render(data);}
    catch {if(sequence===this.sequence)this.disconnect();}
  }
  render({mode,schedule:s,crypto:c,desk:d,now}) {
    this.section.querySelector('[data-session-state]').textContent=s?label(s.phase).toUpperCase():'SIMULATION';
    this.section.querySelector('[data-session-message]').textContent=s?s.note:'Provider scheduling, market-cap ranking and company-news research run in paper/shadow mode. This demo uses synthetic prices.';
    if(!s){this.section.querySelector('[data-session-content]').replaceChildren();return;}
    const a=d?.allocation, rows=d?.watchlist??[], ranks=c?.rows??[], usable=ranks.filter(r=>r.eligible).length;
    const newsFresh=d?.newsAt&&now-d.newsAt<1800000, coverage=d?.newsComplete&&newsFresh?'Current intake complete':'Incomplete or stale — carry entries blocked';
    const warnings=[s.error,c?.error,d?.error,d?.newsError,d?.scanError,d?.modelReason,d?.allocationAlert?.reason].filter(Boolean);
    this.section.querySelector('[data-session-content]').innerHTML=`<div class="session-cards">
      <article><h3>US equities</h3><strong>${s.equityTracking?'Fast feed on':'Fast feed scheduled off'}</strong><p>09:00–16:00 New York time · exchange days<br>Regular entries from 09:30; holidays and early closes apply.</p><p>Next open: ${esc(time(s.next?.open))}<br>Carry entries: 15:30–15:55 ET · normal sessions</p></article>
      <article><h3>Crypto · 24/7</h3><strong>${c?.mode==='off'?'New entries disabled':`${usable} of 25 available on Alpaca`}</strong><p>Global market-cap leaders, verified USD pairs. No lower-ranked substitutes.</p><p>Ranking: ${esc(time(c?.at))}<br>${c?.fresh&&c?.subscriptionReady?'Current selection ready':'New crypto buys blocked until ranking and subscriptions are ready'}</p></article>
      <article><h3>Overnight allocation</h3><strong>${money(a?.exposure)} / ${money(a?.cap)}</strong><p>${pct(a?.fraction)} of ${money(a?.base)} engine equity · cap ${pct(a?.capFraction)}<br>Held ${money(a?.held)} + pending ${money(a?.reserved)}</p><progress max="100" value="${a?.cap>0?Math.min(100,a.exposure/a.cap*100):0}" aria-label="Overnight allocation used"></progress><p>${a?.available?'':'Allocation unavailable; entries blocked. '}Long-only ${esc(mode)} experiment · GTC protection · exit by session ${Number(d?.policy?.sessions??3)} after entry.</p></article>
      </div><p class="session-warning">${esc(warnings.map(label).join(' · '))}</p>
      <div class="panel-title"><h3>Closing patterns &amp; company news</h3><span>${d?.scanning?'Research running':'Research idle'}</span></div>
      <p class="muted">${esc(coverage)} · news checked ${esc(time(d?.newsAt))} · ${Number(d?.articleCount??0)} articles retained. Jev ${d?.model?.configured?'configured':'not configured'} · ${Number(d?.model?.callsToday??0)} / ${Number(d?.model?.dailyLimit??24)} news calls today. Closing scan ${esc(time(d?.scanAt))}${d?.scanProgress?` · ${Number(d.scanProgress.scanned)} / ${Number(d.scanProgress.total)} eligible stocks`:''}.</p>
      <div class="table-wrap" tabindex="0" role="region" aria-label="Next-session research watchlist"><table><thead><tr><th>STOCK / SESSION</th><th>PLAN</th><th>CLOSING EVIDENCE</th><th>NEWS VIEW</th><th>SOURCE / REQUIREMENT</th></tr></thead><tbody>${rows.length?rows.map(r=>`<tr><td><strong>${esc(r.symbol)}</strong><br><small>${esc(r.targetSession)}</small></td><td class="${r.plan==='avoid'?'negative':''}">${esc(r.stale?'expired':label(r.plan))}</td><td>${r.pattern?`${pct(r.pattern.change)} final-hour move<br>${Number(r.pattern.relativeVolume).toFixed(2)}× participation · ${pct(r.pattern.location)} of range`:'No confirmed pattern'}</td><td>${r.news&&!r.news.reason?`${esc(label(r.news.direction))} · ${pct(r.news.confidence)} model confidence<br>${esc(label(r.news.hazard))}`:'No current classification'}</td><td>${r.articles?.length?link(r.articles[0])+'<br>':''}<small>${esc(r.reason)}</small></td></tr>`).join(''):'<tr><td colspan="5" class="empty">No research candidates yet. A complete scan and fresh news are required; no trade is forced.</td></tr>'}</tbody></table></div>
      <details><summary>Global top 25 and execution eligibility</summary><div class="session-coins">${ranks.map(r=>`<span class="${r.eligible?'':'muted'}">#${Number(r.rank)} <strong>${esc(r.symbol)}</strong> · ${r.eligible?'eligible':esc(label(r.reason))}</span>`).join('')||'<p>No verified ranking snapshot.</p>'}</div></details>
      <p class="muted">${esc(d?.note??'News and closing research unavailable.')} Top watchlist candidates receive stream priority on the next session. Watchlist membership alone never places an order. Existing intraday trades retain their exits. <a href="#strategy-controls-panel">Control “Closing strength + news” below.</a></p>`;
  }
  disconnect() {this.sequence++;this.last=0;this.section.querySelector('[data-session-state]').textContent='STALE';this.section.querySelector('[data-session-message]').textContent='Research status disconnected. Displayed information is historical until the next successful refresh.';}
  clear() {this.disconnect();this.section.querySelector('[data-session-content]').replaceChildren();}
}
