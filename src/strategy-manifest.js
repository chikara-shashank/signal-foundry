import { readFileSync } from 'node:fs';
import { hash } from './util.js';
import { strategyDefinition } from './strategy-registry.js';
import { ADD_POLICY } from './pyramiding.js';

const source = name => readFileSync(new URL(name, import.meta.url), 'utf8').replaceAll('\r\n','\n');
const codeHash = hash(['strategy-setups.js','strategies.js','features.js','microstructure.js','noise-area.js','risk.js','engine.js','strategy-manifest.js','strategy-controls.js','strategy-registry.js','portfolio.js','broker.js','broker-budget.js','workers.js','breakout-exits.js','equity-universe.js','feeds.js','stock-history.js','pyramiding.js','position-book.js','market-schedule.js','crypto-universe.js','news-analysis.js','overnight-policy.js','research-desk.js','config.js','crypto-context.js'].map(name=>[name,source(name)]));
export function strategyManifest(engine, id) {
  const definition = strategyDefinition(id), c = engine.cfg;
  const parameters = { universe:c.universe?.mode==='all'?{...c.universe,crypto:c.cryptoUniverse}:c.symbols,
    cryptoUniverse:c.cryptoUniverse,overnight:c.overnight,newsResearch:c.desk,schedule:'NYSE_calendar_09:00-16:00_America/New_York_v1',
    addToWinners:eAdditions(engine),additionPolicy:ADD_POLICY,
    breakoutProtection:c.breakoutProtection,breakoutArmR:c.breakoutArmR,breakoutTrailR:c.breakoutTrailR,breakoutNoProgress:c.breakoutNoProgress,breakoutMinRewardRisk:c.breakoutMinRewardRisk,
    feed:c.feed, risk:c.risk, maxPosition:c.maxPosition, maxGross:c.maxGross, maxGroup:c.maxGroup,
    maxPositions:c.maxPositions, capital:c.capital, dailyLoss:engine.dailyLossLimit, equityFee:c.equityFee, cryptoFee:c.cryptoFee,
    slippage:c.slippage, maxSpread:c.maxSpread, maxQuoteAge:c.maxQuoteAge, maxHold:c.maxHold, cryptoMaxHold:c.cryptoMaxHold,
    entryTtl:c.entryTtl, cooldown:c.cooldown, quoteScanMs:c.quoteScanMs, noiseSymbol:c.noiseSymbol, noiseNotional:c.noiseNotional, noiseStopBps:c.noiseStopBps,
    jevMode:c.jevMode, jevModel:c.jevModel, jevQuality:c.jevQuality, jevCoherence:c.jevCoherence, enabledStrategies:engine.strategyControls.enabledIds() };
  const manifest = { schema:1, strategy:id, codeHash, parameters, mode:c.mode, accountPolicy:c.accountPolicy,
    trigger:definition?.trigger ?? 'operator', supportedModes:['demo','shadow','paper'], evidenceState:'paper_experiment',
    dataRequirements:id==='close_strength_carry'?['exchange_calendar','completed_closing_bars','fresh_quotes','fresh_complete_news','bounded_news_classification','engine_allocation','GTC_bracket']:definition?.trigger === 'session' ? ['exchange_calendar','prior_session_bars','fresh_quotes'] : ['completed_bars','fresh_quotes'],
    sizingPolicy:id === 'noise_area' ? 'fixed_notional_with_explicit_stop_risk' : 'stop_risk_budget', exitPolicy:'owned_bracket_or_software_exit' };
  return { ...manifest, experimentId:hash(manifest) };
}
function eAdditions(engine) { return engine.strategyControls.enabledIds().filter(id=>engine.strategyControls.additionsEnabled(id)); }
export function qualification(engine, id) {
  const manifest = strategyManifest(engine,id);
  return { experimentId:manifest.experimentId, codeHash, state:manifest.evidenceState, liveEligible:false,
    blockers:['Unseen portfolio validation and independent execution review are required'], manifest };
}
