import { hash } from './util.js';

export const RESEARCH_VERSION = 'sourced-context-1';
const finite = x => typeof x === 'number' && Number.isFinite(x);
const clean = (s, max) => String(s ?? '').replace(/[\x00-\x1f]/g, ' ').slice(0, max);
const bounded = value => finite(value) ? value : null;
const safeUrl = value => { try { const u = new URL(value); return u.protocol === 'https:' ? u.href : null; } catch { return null; } };

export function evidenceDigest(articles) {
  return hash(articles.map(a => [a.id, a.digest]).sort(([a], [b]) => a.localeCompare(b)));
}

// Evidence is captured before inference. Later revisions produce a new packet;
// publication time alone cannot make a document available in a historical run.
export function researchEvidence(engine, symbol, articles, now) {
  if (!/^[A-Z][A-Z0-9.]{0,9}$/.test(symbol) || !finite(now)) throw new Error('research_invalid_symbol_or_time');
  const sources = articles.filter(a => a.symbols?.includes(symbol) && [a.publishedAt,a.updatedAt,a.observedAt].every(t => finite(t) && t <= now)
    && now-a.publishedAt <= 36*3600000).slice(0,4).map(a => ({ id:a.id, digest:a.digest, source:clean(a.source,80),
    headline:clean(a.headline,500), summary:clean(a.summary,1800), url:safeUrl(a.url),
    publishedAt:a.publishedAt, updatedAt:a.updatedAt, observedAt:a.observedAt }));
  if (!sources.length || new Set(sources.map(a=>a.id)).size !== sources.length) return null;
  const f=engine.snapshots.get(symbol), p=engine.portfolio.state;
  const market = f?.bar && f.bar.ts+60000 <= now ? {
    barCompletedAt:f.bar.ts+60000, close:bounded(f.bar.close), ema9:bounded(f.ema9), ema21:bounded(f.ema21),
    rollingVwap:bounded(f.rollingVwap), relativeVolume:bounded(f.relativeVolume), regime:f.regime ?? 'unknown',
  } : null;
  const evidence = { version:RESEARCH_VERSION, symbol, asOf:now, expiresAt:Math.min(now+engine.cfg.researchContext.ttlMs,...sources.map(a=>a.publishedAt+36*3600000)),
    sourceDigest:evidenceDigest(sources), sources, market,
    portfolio:{ observedAt:now, valid:p.valid===true, engineCapital:engine.cfg.capital,
      cashCeiling:bounded(p.cashAvailable), managedGross:bounded(p.managedGross),
      positions:engine.portfolio.positions.map(x=>({symbol:x.symbol,quantity:x.qty})),
      pendingEntries:engine.pending().filter(o=>o.kind==='entry').map(o=>({symbol:o.symbol,quantity:o.qty,filledQuantity:o.filledQty})),
      reservedSymbols:[...p.reservedSymbols] },
    unknowns:['No complete future event calendar or analyst consensus','No fundamentals or stock-float feed in this packet','News coverage does not establish absence of hazards'],
    scope:'Company-news context for equity setups; not an order, return forecast, or options valuation' };
  return {...evidence,id:hash(evidence)};
}

export function validateEvidence(e) {
  if (!e || e.version!==RESEARCH_VERSION || !/^[A-Z][A-Z0-9.]{0,9}$/.test(e.symbol ?? '') || !finite(e.asOf) || !finite(e.expiresAt) || e.expiresAt<=e.asOf
    || !Array.isArray(e.sources) || !e.sources.length || e.sources.length>4 || new Set(e.sources.map(s=>s.id)).size!==e.sources.length) throw new Error('research_invalid_evidence');
  const {id,...body}=e;
  if(id!==hash(body) || e.sourceDigest!==evidenceDigest(e.sources)) throw new Error('research_evidence_integrity');
  for(const s of e.sources) if(!s.id || !s.digest || ![s.publishedAt,s.updatedAt,s.observedAt].every(t=>finite(t)&&t<=e.asOf)) throw new Error('research_future_evidence');
  if(e.market && (!finite(e.market.barCompletedAt)||e.market.barCompletedAt>e.asOf)) throw new Error('research_future_market');
  if(e.portfolio?.observedAt>e.asOf) throw new Error('research_future_portfolio');
  return e;
}

function canonical(value,stripTransport=false) {
  if(Array.isArray(value))return value.map(v=>canonical(v,stripTransport));
  if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).filter(k=>!stripTransport||!['kind','now','warmup'].includes(k)).sort().map(k=>[k,canonical(value[k],stripTransport)]));
  return value;
}
export const researchInputDigest = value => hash(canonical(value));
export const candidateReviewKey = c => hash(canonical({symbol:c.symbol,strategy:c.strategy,ts:c.ts,expires:c.expires,reference:c.reference,stop:c.stop,target:c.target,features:canonical(c.features,true)}));

export function sealResearchRecord(body) { return {...body,id:hash(body)}; }
export function validateResearchRecord(record) {
  const {id,...body}=record ?? {};
  if(id!==hash(body) || record.version!==RESEARCH_VERSION || !['thesis','critic'].includes(record.stage)) throw new Error('research_record_integrity');
  const e=validateEvidence(record.evidence);
  if(record.symbol!==e.symbol || !finite(record.availableAt) || record.availableAt<e.asOf || record.expiresAt!==e.expiresAt
    || !finite(record.costUsd) || record.costUsd<0 || !record.thesis || typeof record.thesis.pass!=='boolean') throw new Error('research_invalid_record');
  const ids=new Set(e.sources.map(s=>s.id));
  const references=[...(record.thesis.support??[]),...(record.thesis.contrary??[]),...(record.critic?.evidenceIds??[])];
  if(references.some(id=>!ids.has(id)) || (record.stage==='critic' && (typeof record.critic?.pass!=='boolean'||!record.parentId))) throw new Error('research_invalid_reference');
  return record;
}
