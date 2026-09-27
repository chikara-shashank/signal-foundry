import { resolve } from 'node:path';
import { hash } from './util.js';
import { DEFAULT_STRATEGIES, strategyDefinition } from './strategy-registry.js';

export function config(env = process.env) {
  const str = (k, d = '') => (env[k] ?? d).trim();
  const num = (k, d, min, max) => {
    const v = Number(str(k, String(d)));
    if (!Number.isFinite(v) || v < min || v > max) throw new Error(`Invalid ${k}`);
    return v;
  };
  const symbols = k => [...new Set(str(k, k === 'EQUITY_SYMBOLS' ? 'SPY,QQQ,AAPL,MSFT,NVDA' : 'BTC/USD,ETH/USD').split(',').map(x => x.trim()).filter(Boolean))];
  const c = {
    mode: str('MODE', 'demo'), accountPolicy: str('ACCOUNT_POLICY', 'dedicated'), port: num('PORT', 8080, 1, 65535), host: str('HOST', '127.0.0.1'),
    dataDir: resolve(str('DATA_DIR', './data')), token: str('DASHBOARD_TOKEN'),
    key: str('ALPACA_KEY'), secret: str('ALPACA_SECRET'), feed: str('ALPACA_FEED', 'iex'),
    cryptoLocation: str('ALPACA_CRYPTO_LOCATION', 'us'), equities: symbols('EQUITY_SYMBOLS'), crypto: symbols('CRYPTO_SYMBOLS'),
    jevMode: str('JEV_MODE', 'off'), jevKey: str('TYPESAFE_API_KEY'), jevModel: str('JEV_MODEL', 'jev-1.13.0'),
    jevBudget: num('JEV_MONTHLY_USD', 60, 0, 60), jevRpm: num('JEV_RPM', 120, 1, 1000),
    jevTimeout: num('JEV_TIMEOUT_MS', 1500, 100, 10000), jevCoherence: num('JEV_MIN_COHERENCE', .8, 0, 1), jevQuality: num('JEV_MIN_QUALITY', .65, 0, 1),
    capital: num('CAPITAL_BUDGET_USD', 10000, 100, 10000000), maxPosition: num('MAX_POSITION_USD', 500, 1, 100000),
    maxGross: num('MAX_GROSS_USD', 2000, 1, 1000000), maxGroup: num('MAX_GROUP_USD', 1500, 1, 1000000),
    risk: num('RISK_PER_TRADE_USD', 10, .01, 10000), dailyLoss: num('DAILY_LOSS_USD', 100, 1, 100000),
    maxPositions: num('MAX_POSITIONS', 0, 0, 50), equityFee: num('EQUITY_FEE_BPS', 1, 0, 100), cryptoFee: num('CRYPTO_FEE_BPS', 25, 0, 200),
    slippage: num('SLIPPAGE_BPS', 3, 0, 100), maxSpread: num('MAX_SPREAD_BPS', 20, .1, 200),
    maxQuoteAge: num('MAX_QUOTE_AGE_MS', 5000, 100, 30000), maxHold: num('MAX_HOLD_MINUTES', 60, 1, 1440) * 60000,
    entryTtl: num('ENTRY_TTL_SECONDS', 20, 1, 120) * 1000, cooldown: num('SYMBOL_COOLDOWN_SECONDS', 300, 0, 86400) * 1000,
    liveAck: str('LIVE_ACK'), expectedAccount: str('EXPECTED_ACCOUNT_ID'), cryptoAck: str('LIVE_CRYPTO_ACK'),
    demoInterval: num('DEMO_INTERVAL_MS', 1000, 50, 60000), retentionDays: num('RETENTION_DAYS', 30, 1, 365),
    heartbeatUrl: str('HEARTBEAT_URL'),
    backupDir: str('BACKUP_EXPORT_DIR'), operatingCostPerDay: str('OPERATING_COST_PER_DAY_USD') === '' ? null : num('OPERATING_COST_PER_DAY_USD',0,0,100000),
    strategies: str('STRATEGIES', DEFAULT_STRATEGIES.join(',')).split(',').map(s => s.trim()).filter(Boolean),
    quoteScanMs: num('QUOTE_SCAN_MS', 250, 100, 5000),
    cryptoMaxHold: num('CRYPTO_MAX_HOLD_MINUTES', 180, 5, 1440) * 60000,
    // Noise-area session strategy: one symbol, fixed notional, far protective stop (software exits do the work).
    noiseSymbol: str('NOISE_AREA_SYMBOL', 'QQQ'), noiseNotional: num('NOISE_AREA_NOTIONAL_USD', 1500, 1, 100000),
    noiseStopBps: num('NOISE_AREA_STOP_BPS', 150, 20, 1000),
    breakoutProtection: str('BREAKOUT_PROTECTION', 'on') === 'on',
    breakoutArmR: num('BREAKOUT_ARM_R', 1, .5, 5), breakoutTrailR: num('BREAKOUT_TRAIL_R', .75, .1, 5),
    breakoutNoProgress: num('BREAKOUT_NO_PROGRESS_MINUTES', 15, 5, 120) * 60000,
    breakoutMinRewardRisk: num('BREAKOUT_MIN_NET_REWARD_RISK', 1, .1, 5),
  };
  if (!['on','off'].includes(str('BREAKOUT_PROTECTION','on'))) throw new Error('Invalid BREAKOUT_PROTECTION');
  c.cryptoUniverse = str('CRYPTO_UNIVERSE', c.mode === 'demo' ? 'static' : 'top25');
  if (!['static','top25','off'].includes(c.cryptoUniverse) || (c.mode !== 'demo' && c.cryptoUniverse === 'static')) throw new Error('Provider crypto must use CRYPTO_UNIVERSE=top25 or off');
  if (c.cryptoUniverse === 'off') c.crypto=[];
  if (c.mode === 'demo' && c.cryptoUniverse === 'top25') throw new Error('Demo uses a static synthetic crypto universe');
  c.overnight = { enabled: str('OVERNIGHT_ENTRIES', ['paper','shadow'].includes(c.mode) ? 'on' : 'off') === 'on',
    capFraction: num('OVERNIGHT_ALLOCATION_FRACTION', .095, .001, .095), positionFraction: num('OVERNIGHT_POSITION_FRACTION', .035, .001, .095),
    sessions: num('OVERNIGHT_MAX_SESSIONS', 3, 1, 10) };
  if (!['on','off'].includes(str('OVERNIGHT_ENTRIES', ['paper','shadow'].includes(c.mode) ? 'on' : 'off')) || !Number.isInteger(c.overnight.sessions)) throw new Error('Invalid overnight policy');
  c.desk = { enabled:c.mode!=='demo', newsPollMs:900000, maxModelCallsPerDay:24, closeScanDelayMs:120000 };
  c.researchContext = {
    mode: str('RESEARCH_CONTEXT_MODE', ['paper','shadow'].includes(c.mode) ? 'shadow' : 'off'),
    maxCallsPerDay: num('RESEARCH_CONTEXT_DAILY_CALLS', 8, 0, 24),
    ttlMs: num('RESEARCH_CONTEXT_TTL_MINUTES', 60, 5, 240) * 60000,
    maxSymbols: num('RESEARCH_CONTEXT_SYMBOLS', 4, 1, 10),
  };
  if (!['off','shadow'].includes(c.researchContext.mode) || !Number.isInteger(c.researchContext.maxCallsPerDay) || !Number.isInteger(c.researchContext.maxSymbols)) throw new Error('Invalid research context policy');
  if (['demo','live'].includes(c.mode) && c.researchContext.mode !== 'off') throw new Error('Research context requires paper/shadow mode');
  c.universe = { mode: str('EQUITY_UNIVERSE', c.mode === 'demo' ? 'static' : 'all'),
    refreshMs: num('UNIVERSE_REFRESH_SECONDS', 300, 120, 3600) * 1000,
    streamLimit: num('UNIVERSE_STREAM_LIMIT', c.feed === 'iex' ? 30 : 60, 1, c.feed === 'iex' ? 30 : 200),
    candidateLimit: num('UNIVERSE_CONTEXT_LIMIT', 80, 1, 200), minPrice: num('UNIVERSE_MIN_PRICE', 2, .01, 10000),
    maxPrice: num('UNIVERSE_MAX_PRICE', 2000, .01, 100000), minDailyDollarVolume: num('UNIVERSE_MIN_DAILY_DOLLARS', 5000000, 0, 1e12),
    minMinuteDollarVolume: num('UNIVERSE_MIN_MINUTE_DOLLARS', 50000, 0, 1e12), minDwellMs: num('UNIVERSE_MIN_DWELL_MINUTES', 15, 0, 120) * 60000 };
  if (!['all','static'].includes(c.universe.mode) || c.universe.minPrice > c.universe.maxPrice ||
      !Number.isInteger(c.universe.streamLimit) || !Number.isInteger(c.universe.candidateLimit)) throw new Error('Invalid universe policy');
  if (!/^[A-Z][A-Z0-9.]{0,9}$/.test(c.noiseSymbol)) throw new Error('Invalid NOISE_AREA_SYMBOL');
  if (c.mode === 'demo' && c.universe.mode !== 'static') throw new Error('Demo uses a static synthetic universe');
  if (!['demo', 'shadow', 'paper', 'live'].includes(c.mode)) throw new Error('Invalid MODE');
  if (!['dedicated', 'shared'].includes(c.accountPolicy)) throw new Error('Invalid ACCOUNT_POLICY');
  if (c.mode === 'live' && c.accountPolicy === 'shared') throw new Error('Shared account support is currently available for paper and local simulation modes only');
  if (!['off', 'shadow', 'filter'].includes(c.jevMode)) throw new Error('Invalid JEV_MODE');
  if (!['iex', 'sip'].includes(c.feed) || !['us', 'us-1'].includes(c.cryptoLocation)) throw new Error('Invalid market feed');
  if (c.token.length < 32 || c.token.startsWith('replace-')) throw new Error('Set a random DASHBOARD_TOKEN of at least 32 characters (see README)');
  if (!c.equities.every(s => /^[A-Z][A-Z0-9.]{0,9}$/.test(s)) || !c.crypto.every(s => /^[A-Z0-9]{2,15}\/USD$/.test(s))) throw new Error('Invalid symbol universe');
  if (!c.equities.length && !c.crypto.length && c.universe.mode === 'static' && c.cryptoUniverse !== 'top25') throw new Error('Empty universe');
  if (new Set(c.strategies).size !== c.strategies.length || !c.strategies.every(s => strategyDefinition(s))) throw new Error('Invalid STRATEGIES');
  if (c.strategies.includes('noise_area')) {
    if (c.mode === 'demo') throw new Error('noise_area needs provider sessions and history; use shadow, paper or live');
    if (c.universe.mode==='static' && !c.equities.includes(c.noiseSymbol)) throw new Error('NOISE_AREA_SYMBOL must be listed in EQUITY_SYMBOLS');
    if (c.noiseNotional > c.maxGroup || c.noiseNotional > c.maxGross) throw new Error('NOISE_AREA_NOTIONAL_USD exceeds MAX_GROUP_USD or MAX_GROSS_USD');
  }
  if (c.equities.length > (c.feed === 'iex' ? 30 : 100)) throw new Error('Universe exceeds configured feed limit');
  if (c.mode !== 'demo' && (!c.key || !c.secret)) throw new Error('ALPACA_KEY and ALPACA_SECRET required');
  if (c.jevMode !== 'off' && !c.jevKey) throw new Error('TYPESAFE_API_KEY required for Jev');
  if (c.mode === 'demo' && c.jevMode !== 'off') throw new Error('Demo forbids paid model calls; use shadow/paper for Jev');
  if (c.mode === 'live' && (c.liveAck !== 'I_ACCEPT_REAL_MONEY_RISK' || !c.expectedAccount)) throw new Error('Live mode requires LIVE_ACK and EXPECTED_ACCOUNT_ID');
  if (c.mode === 'live' && (c.crypto.length || c.cryptoUniverse === 'top25') && c.cryptoAck !== 'I_ACCEPT_SOFTWARE_EXIT_OUTAGE_RISK') throw new Error('Live crypto requires LIVE_CRYPTO_ACK or CRYPTO_UNIVERSE=off');
  if (c.maxPosition > c.maxGross || c.maxGross > c.capital || c.maxGroup > c.maxGross || !Number.isInteger(c.maxPositions)) throw new Error('Inconsistent allocation limits');
  c.symbols = [...c.equities, ...c.crypto];
  c.brokerUrl = c.mode === 'live' ? 'https://api.alpaca.markets' : 'https://paper-api.alpaca.markets';
  if (c.heartbeatUrl && new URL(c.heartbeatUrl).protocol !== 'https:') throw new Error('HEARTBEAT_URL must use HTTPS');
  const { token, key, secret, jevKey, liveAck, cryptoAck, heartbeatUrl, ...publicConfig } = c;
  c.fingerprint = hash(publicConfig);
  c.public = { ...publicConfig, fingerprint: c.fingerprint };
  return c;
}
