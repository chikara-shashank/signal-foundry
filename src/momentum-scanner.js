// Pure offline candidate selector. All times are epoch milliseconds.
// Metadata must come from a point-in-time recorder; booleans are not a substitute
// for retaining provenance. This function cannot certify a provider's history.
export function scan(snapshots, now) {
  if(!Number.isFinite(now))throw new Error('Invalid decision time');
  const selected=[], rejected=[];
  const past=(x,maxAge)=>x&&Number.isFinite(x.availableAt)&&Number.isFinite(x.effectiveAt)&&x.availableAt<=now&&x.effectiveAt<=now&&now-x.effectiveAt<=maxAge;
  for(const s of snapshots){
    let reason=null;
    if(!Number.isFinite(s.observedAt)||s.observedAt>now||now-s.observedAt>5000)reason='snapshot_time';
    else if(!past(s.listing,86400000)||s.listing.value!=='US_LISTED_COMMON'||!past(s.tradable,60000)||s.tradable.value!==true)reason='universe_or_tradability';
    else if(!past(s.float,90*86400000)||!(s.float.value>0&&s.float.value<10000000))reason='float_missing_stale_or_ineligible';
    else if(!past(s.previousClose,4*86400000)||!Number.isFinite(s.previousClose.value)||!(s.previousClose.value>0)||s.splitBasisVerified!==true)reason='price_basis';
    else if(!past(s.volumeBaseline,4*86400000)||s.volumeBaseline.sessions!==30||!Number.isFinite(s.volumeBaseline.value)||!(s.volumeBaseline.value>0)||!(s.volumeBaseline.lastSession<s.sessionDate))reason='volume_baseline';
    else if(!past(s.news,24*3600000)||s.news.classification!=='issuer_or_sec_material'||!s.news.sourceUrl)reason='news_missing_future_or_ineligible';
    else if(s.halted!==false||s.feedHealthy!==true)reason='halt_or_feed';
    else if(!past(s.lastTrade,3000)||!(s.lastTrade.value>=1&&s.lastTrade.value<=20))reason='price_or_stale_trade';
    else if(!past(s.cumulativeVolume,5000)||!Number.isFinite(s.cumulativeVolume.value)||!(s.cumulativeVolume.value>=0))reason='volume_timestamp';
    const gainPct=s.lastTrade?.value/s.previousClose?.value*100-100;
    const dailyVolumeRatio=s.cumulativeVolume?.value/s.volumeBaseline?.value;
    if(!reason&&gainPct<10-1e-10)reason='gain_below_10pct';
    if(!reason&&dailyVolumeRatio<5)reason='volume_below_5x';
    if(reason)rejected.push({symbol:s.symbol,reason});
    else selected.push({symbol:s.symbol,decisionTime:now,gainPct,dailyVolumeRatio,float:s.float.value,newsUrl:s.news.sourceUrl});
  }
  if(new Set(snapshots.map(s=>s.symbol)).size!==snapshots.length)throw new Error('Duplicate symbol snapshots');
  selected.sort((a,b)=>b.gainPct-a.gainPct||b.dailyVolumeRatio-a.dailyVolumeRatio||a.symbol.localeCompare(b.symbol));
  return {selected:selected.slice(0,3),rankedButNotSelected:selected.slice(3),rejected};
}
