import { hash } from './util.js';
import { OPTIONS_POLICY as P, OPTIONS_FINGERPRINT } from './options-policy.js';
import { OPTIONS_CODE_HASH } from './options-manifest.js';
import { freshOptionsState, validateOptionsState, advanceOptions, optionsSummary } from './options-state.js';
const pendingKey = p => `${p.strategy}:${p.underlying}:${p.decisionAt}`;

export function replayOptions(records) {
  if (!records.length || !records[0].initialState) throw new Error('options_tape_checkpoint_required');
  let state = freshOptionsState();
  if (records[0]?.initialState) { state = structuredClone(records[0].initialState); validateOptionsState(state); }
  let prior;
  for (const record of records) {
    if (record.sequence != null) {
      const { recordHash, ...body } = record;
      if (!Number.isSafeInteger(record.sequence) || record.sequence < 1 || recordHash !== hash(body)) throw new Error('options_tape_record_integrity');
      if (prior && (record.sequence !== prior.sequence + 1 || record.previousRecordHash !== prior.recordHash)) throw new Error('options_tape_chain_discontinuity');
    } else if (prior?.sequence != null) throw new Error('options_tape_chain_discontinuity');
    if (record.policyHash !== OPTIONS_FINGERPRINT || record.codeHash !== OPTIONS_CODE_HASH) throw new Error('options_tape_experiment_mismatch');
    if (!record.frameHash || !record.beforeStateHash || !record.pendingKeys) throw new Error('options_tape_integrity_fields_required');
    if (record.frameHash !== hash(record.frame)) throw new Error('options_tape_data_mismatch');
    state.enabled = record.enabled; state.revision = record.revision;
    state.pending = state.pending.filter(p => state.enabled[p.strategy] && (!record.pendingKeys || record.pendingKeys.includes(pendingKey(p))));
    if (record.beforeStateHash !== hash(state)) throw new Error('options_tape_state_discontinuity');
    advanceOptions(state, record.frame, record.allowNew);
    prior = record;
  }
  return { ...optionsSummary(state), trades: state.trades };
}

export function replayOptionsStress(records) {
  // Verify the original observation chain first. Stress decisions then evolve
  // independently; copying primary pending orders or exit times would bias fills.
  replayOptions(records);
  const state=structuredClone(records[0].initialState);
  if(state.positions.length||state.pending.length||state.trades.length)throw new Error('options_stress_requires_flat_experiment_start');
  const policy={...P,latencyMs:3500,slippagePerLeg:P.stressSlippage,feePerContractSide:P.stressFee};
  for(const r of records){state.enabled={...r.enabled};state.revision=r.revision;state.pending=state.pending.filter(p=>state.enabled[p.strategy]);advanceOptions(state,r.frame,r.allowNew,policy);}
  // These paths already paid adverse fees/slippage; do not subtract the
  // dashboard's primary-path cost sensitivity a second time.
  for(const trade of state.trades)trade.stressNetPnl=trade.netPnl;
  return {...optionsSummary(state),policy,trades:state.trades,scenario:'independent_3500ms_adverse_costs',liveEligible:false,
    limitations:['Independent decisions and later quote requirements; snapshots still cannot prove execution.', 'Stress can miss entries, change allocation and trigger different exits. It does not model queue priority, actual assignment or broker fills.']};
}
