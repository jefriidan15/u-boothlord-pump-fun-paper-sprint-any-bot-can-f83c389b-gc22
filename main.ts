// Mean-reversion paper-trading bot for the Pump.fun Paper Sprint (golden-condor-22).
//
// Idea: pump.fun bonding curves overextend in both directions. This bot buys sharp
// pullbacks off a coin's recent peak and exits on a profit target, a stop-loss, or a
// trailing give-back. It never chases a launch, never uses the clock, the environment
// or Math.random — every decision comes from the harness state alone, so the two
// graded executions agree byte for byte.
//
// Price of a coin = virtual_quote_reserves / virtual_token_reserves, compared with
// bigint cross-multiplication (no floats anywhere). A "dip" is how far the current
// price sits below the highest price seen for that mint, in basis points.
//
// Guardrail math: the replay needs at least 20 distinct mints with round trips of
// at least 0.01 SOL each, and at most 5 open positions. Stakes are 0.30 SOL on a
// strong dip (10%+) and 0.10 SOL on a shallow dip (6%+) while the bot still needs
// breadth, so capital cycles through many coins instead of sitting in five.
//
// Fees are ~95/30 bps plus 5000/100000 lamports per order, so a round trip costs
// roughly 2.5%: the profit target (9%) and stop (-6%) are set wide of that.

import {
  LAMPORTS_PER_SOL,
  runBot,
  type BuyInput,
  type SellInput,
} from './vendor/makefun-bot.ts';

// --- tunables (all in lamports / basis points) --------------------------------
const STAKE_LAMPORTS = (LAMPORTS_PER_SOL * 3n) / 10n; // 0.30 SOL on a strong dip
const BREADTH_STAKE_LAMPORTS = LAMPORTS_PER_SOL / 10n; // 0.10 SOL while hunting breadth
const MIN_BUY_LAMPORTS = LAMPORTS_PER_SOL / 50n; // 0.02 SOL, above the 0.01 guardrail
const DIP_BPS = 1000n; // buy a 10% pullback off the recent peak
const BREADTH_DIP_BPS = 600n; // 6% is enough while fewer than 20 coins are held
const MIN_TRADES = 4; // need some activity before trusting a peak
const TAKE_PROFIT_BPS = 900n; // sell at +9% over cost
const STOP_LOSS_BPS = -600n; // sell at -6% under cost
const TRAIL_ARM_BPS = 400n; // trailing exit arms once up 4%
const TRAIL_GIVEBACK_BPS = 500n; // ...and fires after giving back 5 points
const MAX_SLIPPAGE_BPS = 1000; // 10% slippage allowance on every order
const MAX_ROUND_TRIPS_PER_MINT = 2; // at most two entries per coin
const PEAK_MAX_AGE_BATCHES = 300; // a peak older than this is stale: re-anchor it
const BREADTH_TARGET_MINTS = 20; // guardrail: 20 distinct mints

// --- per-mint memory ----------------------------------------------------------
interface MintMemory {
  peakNum: bigint; // numerator of the highest price seen (virtual quote reserves)
  peakDen: bigint; // denominator of the highest price seen (virtual token reserves)
  peakBatch: number; // batch seq when the peak was set
  buysPlaced: number; // entries placed on this mint
  buyPeakNum: bigint; // highest price since the current buy
  buyPeakDen: bigint;
  hasBuyPeak: boolean;
}

const memory = new Map<string, MintMemory>();
const boughtEver = new Set<string>();

/** Compare two price ratios a = aNum/aDen and b = bNum/bDen: 1 if a > b, -1 if a < b, 0 if equal. */
function cmpPrice(aNum: bigint, aDen: bigint, bNum: bigint, bDen: bigint): number {
  const left = aNum * bDen;
  const right = bNum * aDen;
  if (left > right) return 1;
  if (left < right) return -1;
  return 0;
}

/** (a - b) / b in basis points, for price ratios a and b. Negative when a < b. */
function diffBps(aNum: bigint, aDen: bigint, bNum: bigint, bDen: bigint): bigint {
  // (aNum/aDen - bNum/bDen) / (bNum/bDen) * 10000
  // = (aNum*bDen - bNum*aDen) * 10000 / (bNum*aDen)
  const num = (aNum * bDen - bNum * aDen) * 10000n;
  const den = bNum * aDen;
  if (den === 0n) return 0n;
  return num / den;
}

await runBot({
  onHello(state) {
    console.error(
      `mean-reversion bot live: capital ${state.hello.capital.lamports} lamports, ` +
        `max ${state.hello.caps.max_open_positions} positions, seed ${state.hello.seed}`,
    );
  },

  onBatch(state, batch) {
    const { caps } = state.hello;
    const tx = state.txFeeLamports();
    const sells: SellInput[] = [];
    const buys: BuyInput[] = [];

    // Refresh per-mint memory from this batch's events (post-batch reserves).
    const touched = new Set<string>();
    for (const e of batch.events) {
      const curve = state.curves.get(e.mint);
      if (curve === undefined || curve.complete) continue;
      if (curve.virtual_token_reserves === 0n) continue;
      touched.add(e.mint);
      const mem = memory.get(e.mint) ?? {
        peakNum: curve.virtual_quote_reserves,
        peakDen: curve.virtual_token_reserves,
        peakBatch: state.seq,
        buysPlaced: 0,
        buyPeakNum: 0n,
        buyPeakDen: 1n,
        hasBuyPeak: false,
      };
      if (
        cmpPrice(
          curve.virtual_quote_reserves,
          curve.virtual_token_reserves,
          mem.peakNum,
          mem.peakDen,
        ) > 0
      ) {
        mem.peakNum = curve.virtual_quote_reserves;
        mem.peakDen = curve.virtual_token_reserves;
        mem.peakBatch = state.seq;
      } else if (state.seq - mem.peakBatch > PEAK_MAX_AGE_BATCHES) {
        // Stale peak: the coin flatlined long ago, so a "dip" off that peak means
        // nothing. Re-anchor the peak at the live price and wait for a fresh move.
        mem.peakNum = curve.virtual_quote_reserves;
        mem.peakDen = curve.virtual_token_reserves;
        mem.peakBatch = state.seq;
      }
      memory.set(e.mint, mem);
    }

    // --- exits: check every open position ------------------------------------
    for (const [mint, holding] of state.positions) {
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      if (curve.virtual_token_reserves === 0n || holding.cost_lamports === 0n) continue;
      const mem = memory.get(mint);
      if (mem === undefined) continue;
      const priceNum = curve.virtual_quote_reserves;
      const priceDen = curve.virtual_token_reserves;
      // Current value of the holding at the live price.
      const valueNow = (holding.token_amount * priceNum) / priceDen;
      const pnlBps =
        ((valueNow - holding.cost_lamports) * 10000n) / holding.cost_lamports;
      // Track the peak price since this buy for the trailing exit.
      if (
        !mem.hasBuyPeak ||
        cmpPrice(priceNum, priceDen, mem.buyPeakNum, mem.buyPeakDen) > 0
      ) {
        mem.buyPeakNum = priceNum;
        mem.buyPeakDen = priceDen;
        mem.hasBuyPeak = true;
      }
      const peakValue = (holding.token_amount * mem.buyPeakNum) / mem.buyPeakDen;
      const peakPnlBps =
        ((peakValue - holding.cost_lamports) * 10000n) / holding.cost_lamports;
      const trailingHit =
        peakPnlBps >= TRAIL_ARM_BPS && pnlBps <= peakPnlBps - TRAIL_GIVEBACK_BPS;
      if (pnlBps >= TAKE_PROFIT_BPS || pnlBps <= STOP_LOSS_BPS || trailingHit) {
        sells.push({
          side: 'sell',
          mint,
          token_amount: holding.token_amount,
          max_slippage_bps: MAX_SLIPPAGE_BPS,
        });
        mem.hasBuyPeak = false;
      }
    }

    // --- entries: rank this batch's touched mints by dip, deepest first -------
    interface Candidate {
      mint: string;
      dip: bigint;
      stake: bigint;
    }
    const candidates: Candidate[] = [];
    for (const mint of touched) {
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      if (curve.trades < MIN_TRADES) continue;
      if (state.positions.has(mint)) continue;
      const mem = memory.get(mint);
      if (mem === undefined || mem.buysPlaced >= MAX_ROUND_TRIPS_PER_MINT) continue;
      // A buy already in flight for this mint blocks a second one.
      let pendingBuy = false;
      for (const p of state.pending.values()) {
        if (p.order.side === 'buy' && p.order.mint === mint) {
          pendingBuy = true;
          break;
        }
      }
      if (pendingBuy) continue;
      const dip = diffBps(
        curve.virtual_quote_reserves,
        curve.virtual_token_reserves,
        mem.peakNum,
        mem.peakDen,
      );
      // diffBps is negative when the price sits below the peak; flip the sign.
      const dipBelowPeak = -dip;
      const alreadyBought = boughtEver.has(mint);
      const threshold = alreadyBought
        ? DIP_BPS
        : boughtEver.size < BREADTH_TARGET_MINTS
          ? BREADTH_DIP_BPS
          : DIP_BPS;
      if (dipBelowPeak < threshold) continue;
      const stake = alreadyBought
        ? STAKE_LAMPORTS
        : boughtEver.size < BREADTH_TARGET_MINTS
          ? BREADTH_STAKE_LAMPORTS
          : STAKE_LAMPORTS;
      candidates.push({ mint, dip: dipBelowPeak, stake });
    }
    candidates.sort((a, b) => {
      if (a.dip !== b.dip) return a.dip > b.dip ? -1 : 1;
      return a.mint < b.mint ? -1 : a.mint > b.mint ? 1 : 0;
    });

    let free = state.freeCashLamports();
    let slots = caps.max_open_positions - state.committedPositionCount();
    for (const c of candidates) {
      if (buys.length + sells.length >= caps.max_orders_per_batch) break;
      if (slots <= 0) break;
      const cap = state.maxBuyLamports(c.mint);
      if (cap < MIN_BUY_LAMPORTS) continue;
      let amount = c.stake < cap ? c.stake : cap;
      if (amount > free - tx) amount = free - tx;
      if (amount < MIN_BUY_LAMPORTS) continue;
      buys.push({
        side: 'buy',
        mint: c.mint,
        quote_lamports: amount,
        max_slippage_bps: MAX_SLIPPAGE_BPS,
      });
      free -= amount + tx;
      slots -= 1;
      const mem = memory.get(c.mint);
      if (mem !== undefined) {
        mem.buysPlaced += 1;
        mem.hasBuyPeak = false;
      }
      boughtEver.add(c.mint);
    }

    return [...sells, ...buys];
  },
});
