import { hash } from './util.js';
import { candidateReviewKey, researchInputDigest, validateResearchRecord } from './research-evidence.js';
import { requestFor } from './jev.js';
import { JEV_RUBRIC } from './jev-context.js';

export const REVIEW_POLICIES = ['rules','jev','context','critic'];

export function validateReviewBundle(bundle) {
  if(bundle?.schema!==1||!Array.isArray(bundle.records)||!Array.isArray(bundle.models)||!Array.isArray(bundle.invalidations)||!Array.isArray(bundle.charges)||!Array.isArray(bundle.coverageTimeline))throw new Error('recorded_review_bundle_invalid');
  const {digest,...body}=bundle;if(digest!==hash(body))throw new Error('recorded_review_bundle_integrity');
  const records=new Map();
  for(const r of bundle.records){validateResearchRecord(r);if(records.has(r.id))throw new Error('recorded_review_duplicate');records.set(r.id,r);}
  for(const r of bundle.records)if(r.stage==='critic'){
    const parent=records.get(r.parentId);
    if(!parent||parent.stage!=='thesis'||parent.evidence.id!==r.evidence.id||parent.availableAt>r.availableAt||hash(parent.thesis)!==hash(r.thesis))throw new Error('recorded_review_parent_invalid');
  }
  const keys=new Set();
  for(const m of bundle.models){
    if(keys.has(m.candidateKey)||!/^[a-f0-9]{64}$/.test(m.candidateKey??'')||!Number.isFinite(m.requestedAt)||!Number.isFinite(m.availableAt)||m.availableAt<m.requestedAt
      ||typeof m.pass!=='boolean'||!Number.isFinite(m.costUsd)||m.costUsd<0||!m.model||!m.rubricVersion||!m.thresholds||!/^[a-f0-9]{64}$/.test(m.inputDigest??''))throw new Error('recorded_model_invalid');
    keys.add(m.candidateKey);
  }
  for(const i of bundle.invalidations)if(!records.has(i.recordId)||!Number.isFinite(i.at))throw new Error('recorded_invalidation_invalid');
  const charges=new Set();
  for(const c of bundle.charges){if(charges.has(c.id)||!Number.isFinite(c.at)||!Number.isFinite(c.costUsd)||c.costUsd<0||!['thesis','critic'].includes(c.stage))throw new Error('recorded_charge_invalid');charges.add(c.id);}
  for(const [i,c] of bundle.coverageTimeline.entries())if(!Number.isFinite(c.at)||typeof c.available!=='boolean'||i&&c.at<=bundle.coverageTimeline[i-1].at)throw new Error('recorded_coverage_invalid');
  return bundle;
}

// Replay-only adapter. It never requests a model or broker; decisions arriving
// later are queued while market events continue, then every entry gate reruns.
export class RecordedResearch {
  constructor(engine,bundle,policy) {
    if(!REVIEW_POLICIES.includes(policy))throw new Error('Unknown recorded review policy');
    this.engine=engine;this.bundle=validateReviewBundle(bundle);this.policy=policy;this.waiting=[];this.usedModels=new Map();
    this.rows=[];this.counts={missing:0,accepted:0,declined:0,expired:0,preflightBlocked:0};
  }
  context(symbol,now) {
    if(!this.bundle.coverageTimeline.findLast(c=>c.at<=now)?.available)return null;
    return this.bundle.records.filter(r=>r.symbol===symbol&&r.model===this.engine.cfg.jevModel&&r.availableAt<=now&&r.expiresAt>now
      &&!this.bundle.invalidations.some(i=>i.at<=now&&this.bundle.records.find(x=>x.id===i.recordId)?.evidence.id===r.evidence.id))
      .sort((a,b)=>b.availableAt-a.availableAt||(a.stage==='critic'?-1:1))[0]??null;
  }
  async submit(c) {
    const e=this.engine,key=candidateReviewKey(c),preflight=await e.mutex.run(()=>e.checkEntry(c));
    c.preflight=preflight;
    const row={candidateKey:key,candidateId:c.id,symbol:c.symbol,strategy:c.strategy,at:c.ts,policy:this.policy};this.rows.push(row);
    if(!preflight.ok){this.counts.preflightBlocked++;row.reason=preflight.reason;e.reject(c,preflight.reason);return;}
    if(this.policy==='jev'){
      const m=this.bundle.models.find(m=>m.candidateKey===key);
      if(!m||m.requestedAt<c.ts){this.counts.missing++;row.reason='recorded_model_missing';e.reject(c,row.reason);return;}
      if(m.model!==e.cfg.jevModel||m.rubricVersion!==JEV_RUBRIC||m.thresholds.coherence!==e.cfg.jevCoherence||m.thresholds.quality!==e.cfg.jevQuality
        ||m.thresholds.excludedRegime!=='disorderly'||m.inputDigest!==researchInputDigest(requestFor(c,e.cfg.jevModel,e.cfg))){
        this.counts.missing++;row.reason='recorded_model_policy_mismatch';e.reject(c,row.reason);return;
      }
      this.usedModels.set(key,m);
      this.waiting.push({c,row,m,due:m.availableAt});return;
    }
    const context=this.policy==='rules'?null:this.context(c.symbol,c.ts);
    if(this.policy!=='rules'&&(!context||(this.policy==='critic'&&!context.critic))){
      this.counts.missing++;row.reason='recorded_context_missing';e.reject(c,row.reason);return;
    }
    const pass=this.policy==='rules'||(context.thesis.pass&&(this.policy!=='critic'||context.critic.pass));
    c.research=context?{id:context.id,evidenceId:context.evidence.id,mode:'replay',contextPass:context.thesis.pass,criticPass:context.critic?.pass??null}:null;
    await this.resolve(c,row,{pass,requested:false,mode:'recorded_'+this.policy});
  }
  async resolve(c,row,result) {
    const e=this.engine;c.model=result;
    if(!result.pass){this.counts.declined++;row.reason=result.error??'recorded_'+this.policy+'_declined';e.reject(c,row.reason);return;}
    if(e.clock()>=c.expires){this.counts.expired++;row.reason='recorded_review_expired';e.reject(c,row.reason);return;}
    this.counts.accepted++;
    await e.mutex.run(()=>e.enter(c));row.reason=c.reason??null;row.status=c.status;row.orderId=c.orderId??null;
  }
  async advance(now) {
    const ready=this.waiting.filter(w=>w.due<=now||w.c.expires<=now);this.waiting=this.waiting.filter(w=>!ready.includes(w));
    for(const {c,row,m} of ready){
      if(m.availableAt>now){this.counts.expired++;row.reason='recorded_review_expired';this.engine.reject(c,row.reason);continue;}
      await this.resolve(c,row,{...m,mode:'recorded_jev',requested:true,latencyMs:m.availableAt-m.requestedAt,cost:m.costUsd});
    }
  }
  report(start,end) {
    const stages=this.policy==='critic'?['thesis','critic']:this.policy==='context'?['thesis']:[];
    // Include failed/reserved research attempts and all recorded jobs during the
    // window, not only the successful context eventually attached to a fill.
    const researchCost=this.bundle.charges.filter(c=>c.at>=start&&c.at<=end&&stages.includes(c.stage)).reduce((s,c)=>s+c.costUsd,0);
    const modelCost=[...this.usedModels.values()].reduce((s,m)=>s+m.costUsd,0);
    return {policy:this.policy,bundleDigest:this.bundle.digest,counts:this.counts,pending:this.waiting.length,
      modelCostUsd:modelCost,researchCostUsd:researchCost,totalCostUsd:modelCost+researchCost,candidates:this.rows,
      costBasis:'Recorded research attempts within the window plus matched Jev requests; unknown billing uses its reservation. Pre-window research cost excluded. This is a recorded-schedule comparison, not a counterfactual research scheduler.'};
  }
}
