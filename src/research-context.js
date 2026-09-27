import { hash, nyDate } from './util.js';
import { RESEARCH_VERSION, evidenceDigest, researchEvidence, sealResearchRecord } from './research-evidence.js';
import { ResearchJournal } from './research-journal.js';
import { researchCall } from './research-model.js';

export class ResearchContext {
  constructor(engine) {
    this.engine=engine;this.journal=new ResearchJournal(engine.store);this.busy=false;this.lastPoll=-Infinity;
    this.records=this.journal.records();this.invalidated=new Set(this.journal.invalidations().map(i=>i.recordId));
    this.lastCoverage=this.journal.latestCoverage();
    this.status={reason:null,lastRunAt:null};
  }
  reference(symbol,now=this.engine.clock(),recordInvalidation=true) {
    if(this.engine.cfg.researchContext.mode!=='shadow')return null;
    if(!this.coverage(now,recordInvalidation))return null;
    const r=this.records.find(r=>r.symbol===symbol&&r.availableAt<=now);
    if(!r||r.expiresAt<=now||r.model!==this.engine.cfg.jevModel||this.invalidated.has(r.id))return null;
    const desk=this.engine.desk,articles=desk?.relevant(symbol,now)??[];
    const reason=evidenceDigest(articles)!==r.evidence.sourceDigest?'research_sources_changed':null;
    if(reason){
      if(recordInvalidation){
        for(const related of this.records.filter(x=>x.evidence.id===r.evidence.id)){
          this.invalidated.add(related.id);this.journal.invalidate(related.id,now,reason);
        }
        this.engine.store.event('research_invalidation',{recordId:r.id,symbol,reason},now);
      }
      return null;
    }
    return {id:r.id,evidenceId:r.evidence.id,version:r.version,mode:'shadow',availableAt:r.availableAt,expiresAt:r.expiresAt,
      stage:r.stage,contextPass:r.thesis.pass,criticPass:r.critic?.pass??null};
  }
  coverage(now,persist=true) {
    const state=this.engine.desk?.state;
    const available=!!state?.newsComplete&&Number.isFinite(state.newsAt)&&now>=state.newsAt&&now-state.newsAt<1800000;
    if(persist&&(!this.lastCoverage||now>=this.lastCoverage.at&&Boolean(this.lastCoverage.available)!==available)){
      this.journal.coverage(now,available);this.lastCoverage={at:now,available};
    }
    return available;
  }
  snapshot() {
    const e=this.engine,now=e.clock(),latest=new Map();
    for(const r of this.records)if(!latest.has(r.symbol))latest.set(r.symbol,r);
    return {mode:e.cfg.researchContext.mode,configured:!!e.cfg.jevKey&&e.cfg.jevMode!=='off',version:RESEARCH_VERSION,
      busy:this.busy,...this.status,callsToday:e.store.get('researchContextCalls:'+nyDate(now),0),dailyLimit:e.cfg.researchContext.maxCallsPerDay,
      rows:[...latest.values()].slice(0,10).map(r=>({...r,current:!!this.reference(r.symbol,now,false)})),
      jobs:this.journal.latestJobs().map(j=>({symbol:j.symbol,stage:j.stage,reason:j.reason??null,nextAttemptAt:j.nextAttemptAt})),
      note:'Shadow research only. Context and critic do not approve, block or size orders. Missing event calendars, fundamentals and coverage remain unknown; model scores are not win probabilities.'};
  }
  append(record) {
    this.journal.append(record);this.records=[record,...this.records.filter(r=>r.id!==record.id)].slice(0,80);
  }
  async poll() {
    const e=this.engine,now=e.clock(),desk=e.desk;
    if(this.busy||e.stopped||e.cfg.researchContext.mode!=='shadow'||now-this.lastPoll<15000)return;
    this.lastPoll=now;
    for(const symbol of new Set(this.records.map(r=>r.symbol)))this.reference(symbol,now);
    if(!this.coverage(now)){this.status.reason='research_news_coverage_stale';return;}
    this.busy=true;
    try {
      const priorities=[...Object.keys(e.managed),...desk.state.watchlist.filter(r=>r.plan!=='avoid'&&r.expiresAt>now).map(r=>r.symbol)];
      const symbols=[...new Set(priorities)].filter(s=>/^[A-Z][A-Z0-9.]{0,9}$/.test(s)).slice(0,e.cfg.researchContext.maxSymbols);
      this.status.reason=symbols.length?null:'research_waiting_for_watchlist';
      for(const symbol of symbols){
        if(e.stopped)break;
        const articles=desk.relevant(symbol,e.clock());if(!articles.length)continue;
        const id=hash({version:RESEARCH_VERSION,symbol,sources:evidenceDigest(articles),model:e.cfg.jevModel,window:Math.floor(now/e.cfg.researchContext.ttlMs)});
        let job=this.journal.job(id);
        if(job?.stage==='complete'||job?.nextAttemptAt>now)continue;
        if(!job){const evidence=researchEvidence(e,symbol,articles,now);if(!evidence)continue;job={id,symbol,evidence,stage:'thesis',attempts:0,costUsd:0};}
        if(job.evidence.expiresAt<=e.clock()){job.stage='expired';this.journal.saveJob(job);continue;}
        // A saved thesis can resume at the critic after a restart. Repeating an
        // uncertain HTTP request consumes another reservation, never a free retry.
        const stage=job.stage==='critic'?'critic':'thesis';
        job.attempts++;job.nextAttemptAt=now+300000;this.journal.saveJob(job);
        const result=await researchCall(e.jev,job.evidence,stage,job.thesis??null,()=>e.clock());
        job.costUsd+=result.costUsd;job.reason=result.reason??null;this.status.reason=job.reason;this.status.lastRunAt=e.clock();
        if(!result.ok){this.journal.saveJob(job);break;}
        if(stage==='thesis')job.thesis=result.answer;
        const record=sealResearchRecord({version:RESEARCH_VERSION,symbol,evidence:job.evidence,stage,model:e.cfg.jevModel,
          availableAt:result.availableAt,expiresAt:job.evidence.expiresAt,costUsd:job.costUsd,requestId:result.id,
          thesis:job.thesis,critic:stage==='critic'?result.answer:null,parentId:stage==='critic'?job.thesisId:null});
        this.append(record);
        if(stage==='thesis'){job.thesisId=record.id;job.stage='critic';job.nextAttemptAt=0;}
        else{job.stage='complete';job.nextAttemptAt=null;}
        this.journal.saveJob(job);
        break; // At most one bounded HTTP attempt per poll, outside entry processing.
      }
    }catch{this.status.reason='research_context_unavailable';}
    finally{this.busy=false;}
  }
}
