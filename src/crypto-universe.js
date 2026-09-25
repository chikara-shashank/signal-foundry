import { isCrypto } from './util.js';

// Identity mappings, not a ranking. Unknown/ambiguous identities are not traded.
// Rank and market cap always come from the current provider snapshot.
export const CRYPTO_IDENTITIES = Object.freeze({ BTC:'btc-bitcoin', ETH:'eth-ethereum', USDT:'usdt-tether', USDC:'usdc-usd-coin', XRP:'xrp-xrp', SOL:'sol-solana', HYPE:'hype-hyperliquid', DOGE:'doge-dogecoin', LINK:'link-chainlink', ADA:'ada-cardano', BCH:'bch-bitcoin-cash', AVAX:'avax-avalanche', LTC:'ltc-litecoin', DOT:'dot-polkadot', SHIB:'shib-shiba-inu', UNI:'uni-uniswap', AAVE:'aave-new', ONDO:'ondo-ondo-finance', PAXG:'paxg-pax-gold', PEPE:'pepe-pepe', NEAR:'near-near-protocol', XLM:'xlm-stellar', BNB:'bnb-binance-coin', TRX:'trx-tron' });
export function rankCrypto(rows, assets, now) {
  if (!Array.isArray(rows) || rows.length < 25 || rows.length > 20000) throw new Error('crypto_ranking_invalid');
  const top = rows.filter(r => Number.isInteger(r.rank) && r.rank >= 1 && r.rank <= 25).sort((a,b) => a.rank-b.rank);
  if (top.length !== 25 || top.some((r,i) => r.rank !== i + 1 || !Number.isFinite(r.quotes?.USD?.market_cap) || r.quotes.USD.market_cap <= 0 || !Number.isFinite(Date.parse(r.last_updated)) || now - Date.parse(r.last_updated) > 3600000 || Date.parse(r.last_updated) > now + 60000)) throw new Error('crypto_ranking_incomplete_or_stale');
  const counts = new Map(); for(const r of top)counts.set(r.symbol,(counts.get(r.symbol)??0)+1);
  return top.map(r => {
    const symbol = `${r.symbol}/USD`, a = assets.get(symbol), unique = counts.get(r.symbol) === 1;
    const reason = !unique || CRYPTO_IDENTITIES[r.symbol] !== r.id ? 'unverified_coin_identity' : !a?.tradable || a.assetClass !== 'crypto' || a.status !== 'active' ? 'not_available_on_alpaca' : null;
    return { id:r.id, symbol, name:String(r.name).slice(0,80), rank:r.rank, marketCap:r.quotes.USD.market_cap, providerAt:Date.parse(r.last_updated), eligible:!reason, reason };
  });
}
export class CryptoUniverse {
  constructor(engine, venue, fetchFn = fetch) { this.engine=engine; this.venue=venue; this.fetch=fetchFn; this.busy=false; this.retryAt=0; this.feed=null; this.state=engine.store.get('cryptoUniverse',{ rows:[], at:0, subscriptionReady:false }); }
  pins() { return [...new Set([...Object.keys(this.engine.managed), ...this.engine.pending().map(o=>o.symbol)])].filter(isCrypto); }
  fresh(now = this.engine.clock()) { return this.state.at>0 && now-this.state.at>=-1000 && now-this.state.at<6*3600000 && this.state.rows.length===25 && this.state.rows.every(r=>now-r.providerAt<6*3600000); }
  allowed(symbol, now = this.engine.clock()) { return this.fresh(now) && this.state.subscriptionReady && this.state.rows.some(r=>r.symbol===symbol&&r.eligible&&r.rank<=25); }
  restore() {
    const e=this.engine, selected=this.fresh()?this.state.rows.filter(r=>r.eligible).map(r=>r.symbol):[];
    e.cfg.crypto=[...new Set([...this.pins(),...selected])]; e.cfg.symbols=[...e.cfg.equities,...e.cfg.crypto];
    this.state.subscriptionReady=false; e.realtime.trades.setSymbols(e.cfg.symbols);
  }
  status() { return {...this.state, fresh:this.fresh(), pins:this.pins(), scanning:this.busy, source:'CoinPaprika global market-cap ranks ∩ Alpaca tradable USD pairs', note:'No lower-ranked substitutes. A coin that leaves the top 25 remains subscribed only while an existing position/order needs protection. Stale rankings block new crypto buys.'}; }
  async poll(force = false) {
    const e=this.engine, now=e.clock();
    if(this.busy||e.stopped||now<this.retryAt||(!force&&this.fresh()&&this.state.subscriptionReady&&now-this.state.at<3600000))return;
    this.busy=true; this.retryAt=now+300000;
    try {
      const response=await this.fetch('https://api.coinpaprika.com/v1/tickers?quotes=USD',{redirect:'error',signal:AbortSignal.timeout(12000)});
      if(!response.ok)throw new Error('crypto_ranking_http_'+response.status);
      const raw=await response.text(); if(raw.length>12000000)throw new Error('crypto_ranking_payload_limit');
      const assets=await this.venue.assets(), rows=rankCrypto(JSON.parse(raw),assets,e.clock());
      if(e.stopped)return;
      await e.mutex.run(()=>{
        for(const [symbol,asset] of assets)e.assets.set(symbol,asset);
        this.state={rows,at:e.clock(),subscriptionReady:false,error:null};
        // Preserve all old subscriptions until broker-confirmed subscription change.
        e.cfg.crypto=[...new Set([...e.cfg.crypto,...this.pins(),...rows.filter(r=>r.eligible).map(r=>r.symbol)])];
        e.cfg.symbols=[...e.cfg.equities,...e.cfg.crypto];
      });
      const selected=[...new Set([...this.pins(),...rows.filter(r=>r.eligible).map(r=>r.symbol)])];
      await this.feed?.setSymbols(selected); if(e.stopped)return;
      await e.mutex.run(()=>{
        const removed=e.cfg.crypto.filter(s=>!selected.includes(s));
        e.cfg.crypto=selected; e.cfg.symbols=[...e.cfg.equities,...selected]; e.realtime.trades.setSymbols(e.cfg.symbols);
        for(const s of removed)for(const map of [e.quotes,e.snapshots,e.cryptoFeatures.history,e.quoteHistory])map.delete(s);
        this.state.subscriptionReady=true; e.store.set('cryptoUniverse',this.state);
        e.store.event('crypto_universe',{at:this.state.at,rows,selected},e.clock());
        if(e.cryptoContext)e.cryptoContext.lastBucket=null;
      });
    } catch(error){this.state.error=/^crypto_ranking_\w+$/.test(error.message)?error.message:'crypto_universe_unavailable';}
    finally{this.busy=false;}
  }
}
