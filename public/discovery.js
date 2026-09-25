const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const n=x=>Number(x??0).toLocaleString();
export class DiscoveryView {
  constructor() {
    const section=document.createElement('section');section.className='panel';section.id='discovery-panel';
    section.innerHTML='<div class="panel-title"><h2>Stock discovery</h2><span id="discovery-state" class="pill">CONNECTING</span></div><p id="discovery-coverage"></p><p id="discovery-health" class="muted"></p><details><summary>Selected stocks and screening results</summary><p id="discovery-filters" class="muted"></p><div class="table-wrap"><table><thead><tr><th>SYMBOL</th><th>SELECTION</th><th>SETUPS MATCHED</th><th>SPREAD</th><th>MINUTE DOLLAR VOLUME</th></tr></thead><tbody id="discovery-rows"></tbody></table></div></details>';
    document.getElementById('discovery-mount').replaceWith(section);
  }
  render(status) {
    const u=status.universe,$=id=>document.getElementById(id);
    $('discovery-state').textContent=u?`${u.mode.toUpperCase()} · ${u.state.toUpperCase()}`:'UNAVAILABLE';
    $('discovery-coverage').textContent=!u?'This runtime does not report universe discovery.':u.mode==='static'?`${n(u.streamed)} configured stocks. Full-universe discovery is disabled in this run.`:`${n(u.scanned)} / ${n(u.eligibleAssets)} eligible listed stocks and ETFs screened · ${n(u.passedScreen)} passed price, liquidity and spread checks · ${n(u.contextChecked)} checked against completed strategy history · ${n(u.streamed)} / ${n(u.streamLimit)} streaming slots.`;
    $('discovery-health').textContent=u?.mode==='all'?`${u.scanning?'Scan in progress. ':''}${u.error?u.error.replaceAll('_',' ')+'. ':''}Last completed scan: ${u.lastCompleteAt?new Date(u.lastCompleteAt).toLocaleString():'none'}. ${u.note} ${u.feed==='iex'?'IEX quotes cover one exchange, not the consolidated market.':''}`:'';
    $('discovery-filters').textContent=Object.entries(u?.rejections??{}).map(([k,v])=>`${k.replaceAll('_',' ')}: ${n(v)}`).join(' · ');
    $('discovery-rows').innerHTML=(u?.selected??[]).map(x=>`<tr><td>${esc(x.symbol)}</td><td>${x.pinned?'Retained for position or session strategy':x.contextReady?'Strategy context ranked':'Warming context'}</td><td>${esc(x.matches?.join(', ').replaceAll('_',' ')||'Waiting for a setup')}</td><td>${Number.isFinite(x.spreadBps)?x.spreadBps.toFixed(1)+' bps':'—'}</td><td>${x.minuteDollarVolume?'$'+n(Math.round(x.minuteDollarVolume)):'—'}</td></tr>`).join('');
  }
}
