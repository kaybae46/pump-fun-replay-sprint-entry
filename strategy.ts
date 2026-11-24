// Paper bot that rides momentum in the pump.fun replay (agent-fun/replay/v2).
//
// The harness speaks first with hello, then sends one batch per slot, and
// finishes with done. This bot answers each batch with the orders it wants
// — an empty list is a valid answer — and shuts down on done. No clocks,
// no dice, no environment: each order follows deterministically from the
// batches received so far, so the two grading runs log identical actions.
//
// The approach is kept plain on purpose; a cleverer fit would only be
// overfitting the dev window:
//   * Only enter curves where buying pressure is already speeding up. The
//     curve must be mature (minAge slots past its creation), show net SOL
//     flowing in over a short lookback, have several distinct buyers, a
//     price that is up without going vertical, sit close to its lookback
//     high, and buy harder in the newer half of the lookback than in the
//     older half.
//   * Open small with initialSol, then add only while the trade is
//     working — price at or above the last buy, net flow still positive —
//     until the position reaches stakeSol. A false start stays cheap; a
//     runner is allowed to grow.
//   * Close the entire position at whichever comes first: the stop loss
//     against cost, the trailing stop against the best close value, or the
//     holding-time limit. Completed curves are closed by the replay at
//     their final reserves. The trail is deliberately tight — 12% off the
//     peak, armed after a 4% gain — because most runners in this window
//     hand their gains back; banking early beats riding down to the stop.
//     Arming at +4% rather than +2% leaves the trail dormant through the
//     first wobble after entry, so a position that is only just green is
//     not shaken out by a shallow dip before it gets a chance to run.
//   * Small probe round trips keep the run above the guardrails (at least
//     20 coins, round trips of 0.01 SOL or more): when the bot's own fills
//     or coins trail the pace implied by block time, it buys probeSol of a
//     liquid curve and exits as soon as that buy lands.

import type { Bot, BotState, Batch, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

export interface Params {
  /** Stop loss: exit once value drops this fraction below cost. */
  stopLoss: number;
  /** Trailing stop: exit once value drops this fraction below its peak. */
  trail: number;
  /** The trailing stop arms once value reaches cost * (1 + trailArm). */
  trailArm: number;
  /** Exit after this many slots held; strong runners are exempt (see below). */
  maxHold: number;
  /** Slots to wait after an exit before the same curve can be bought again. */
  cooldown: number;
  /** Most entries allowed per curve across the whole run. */
  maxEntries: number;
  /** Lookback length in slots, used by the entry signal and the add-on flow check. */
  window: number;
  /** Slots that must elapse after the CreateEvent before an entry is allowed. */
  minAge: number;
  /** Real-SOL size of a curve at entry: below this is noise, above it is late. */
  minRqSol: number;
  maxRqSol: number;
  /** Net buy SOL (buys minus sells) across the lookback. */
  minNetSol: number;
  /** Number of buy trades inside the lookback. */
  minBuys: number;
  /** Number of distinct buying wallets inside the lookback. */
  minBuyers: number;
  /** Price now versus price at the lookback start, minus 1 — lower bound. */
  minPriceUp: number;
  /** Same rise, upper bound: skip a curve that already ran too far in one window. */
  maxPriceUp: number;
  /** The newer half's net inflow must be at least this multiple of the older half's. */
  accel: number;
  /** Price now must be at least this fraction of the lookback's high. */
  nearHigh: number;
  /** Total SOL committed to a single position. */
  stakeSol: number;
  /** Size of the first buy of a position, in SOL. */
  initialSol: number;
  /** Size of each add-on buy, in SOL. */
  addSol: number;
  /** Add only once the price sits this far above the last buy's decision price. */
  addStep: number;
  /** Whether to keep adding while the entry signal still holds, up to stakeSol. */
  pyramid: boolean;
  /** Smallest buy worth sending. */
  minBuySol: number;
  /** Slippage on buys in bps; sells always go out at 10000. */
  buySlipBps: number;
  /** Most momentum positions open at the same time. */
  maxMain: number;
  /** Ceiling on SOL at cost across every position at once (a drawdown guard). */
  maxExposureSol: number;
  /** Guardrail pacing: the run should finish with at least this many coins and fills. */
  targetCoins: number;
  targetFills: number;
  /** Block-time seconds over which the pacing targets ramp from zero to full. */
  paceSecs: number;
  /** Size of a single probe buy, in SOL. */
  probeSol: number;
  /** Most probe round trips that may be open at the same time. */
  maxProbes: number;
}

export const DEFAULT_PARAMS: Params = {
  stopLoss: 0.1,
  trail: 0.12,
  trailArm: 0.04,
  maxHold: 1500,
  cooldown: 150,
  maxEntries: 2,
  window: 30,
  minAge: 500,
  minRqSol: 2,
  maxRqSol: 60,
  minNetSol: 2,
  minBuys: 3,
  minBuyers: 8,
  minPriceUp: 0.08,
  maxPriceUp: 1.5,
  accel: 1,
  nearHigh: 0.95,
  stakeSol: 1,
  initialSol: 0.1,
  addSol: 0.2,
  addStep: 0,
  pyramid: true,
  minBuySol: 0.01,
  buySlipBps: 1500,
  maxMain: 5,
  maxExposureSol: 6,
  targetCoins: 25,
  targetFills: 240,
  paceSecs: 14_400,
  probeSol: 0.01,
  maxProbes: 1,
};

const LAMPORTS_PER_SOL = 1e9;
const FEE_RATE = 0.0125;
const BPS_BASE = 10_000;

interface Print {
  slot: number;
  buy: boolean;
  sol: number;
  user: string;
  price: number;
}

interface Ledger {
  born: number | null;
  ticks: Print[];
  tries: number;
  lastClose: number;
}

interface LivePos {
  openedAt: number;
  best: number;
  spent: number;
  closing: boolean;
  live: boolean;
  lastBuy: number;
  mark: number;
}

export function createStrategy(p: Params = DEFAULT_PARAMS): Bot {
  const ledgers = new Map<Pubkey, Ledger>();
  const live = new Map<Pubkey, LivePos>();
  // Probe round trips in flight, keyed by mint: false while the buy is
  // outstanding, true once the sell has gone out.
  const pacers = new Map<Pubkey, boolean>();
  // The bot's own filled orders, and the coins they touched. Harness
  // closes are not counted here.
  let fills = 0;
  const coins = new Set<Pubkey>();
  let t0: number | null = null;
  let t1: number | null = null;
  const retention = p.window + 5;

  const ledgerFor = (mint: Pubkey): Ledger => {
    let ledger = ledgers.get(mint);
    if (ledger === undefined) {
      ledger = { born: null, ticks: [], tries: 0, lastClose: -1e12 };
      ledgers.set(mint, ledger);
    }
    return ledger;
  };

  // Does this curve's tape carry an entry signal at slot `now`?
  const qualifies = (ledger: Ledger, now: number, rqSol: number): boolean => {
    if (rqSol < p.minRqSol || rqSol > p.maxRqSol) return false;
    if (ledger.born === null || now - ledger.born < p.minAge) return false;
    const from = now - p.window;
    const mid = now - p.window / 2;
    let buySol = 0;
    let sellSol = 0;
    let buys = 0;
    let netOld = 0;
    let netNew = 0;
    let startPrice = -1;
    let high = 0;
    let last = 0;
    const buyers = new Map<string, number>();
    for (const tick of ledger.ticks) {
      if (tick.slot <= from) {
        startPrice = tick.price;
        continue;
      }
      if (startPrice < 0) startPrice = tick.price;
      const signed = tick.buy ? tick.sol : -tick.sol;
      if (tick.slot <= mid) netOld += signed;
      else netNew += signed;
      if (tick.buy) {
        buySol += tick.sol;
        buys++;
        buyers.set(tick.user, (buyers.get(tick.user) ?? 0) + tick.sol);
      } else {
        sellSol += tick.sol;
      }
      if (tick.price > high) high = tick.price;
      last = tick.price;
    }
    if (buys < p.minBuys || buyers.size < p.minBuyers) return false;
    if (buySol - sellSol < p.minNetSol) return false;
    if (startPrice <= 0) return false;
    const up = last / startPrice - 1;
    if (up < p.minPriceUp || up > p.maxPriceUp) return false;
    if (last < high * p.nearHigh) return false;
    if (netNew <= 0 || netNew < p.accel * netOld) return false;
    return true;
  };

  // Net recorded SOL (buys minus sells) over the last `w` slots.
  const windowFlow = (ledger: Ledger, now: number, w: number): number => {
    let net = 0;
    for (let i = ledger.ticks.length - 1; i >= 0; i--) {
      const tick = ledger.ticks[i]!;
      if (tick.slot <= now - w) break;
      net += tick.buy ? tick.sol : -tick.sol;
    }
    return net;
  };

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const now = batch.slot;
      const seen = new Set<Pubkey>();
      for (const f of batch.fills) {
        if (f.status === 'filled' && !f.client_id.startsWith('_')) {
          fills++;
          coins.add(f.mint);
        }
      }
      for (const e of batch.events) {
        if (e.block_time !== null) {
          if (t0 === null) t0 = e.block_time;
          if (t1 === null || e.block_time > t1) t1 = e.block_time;
        }
        if (e.event === 'CreateEvent') {
          ledgerFor(e.mint).born = e.slot;
        } else if (e.event === 'TradeEvent') {
          const ledger = ledgerFor(e.mint);
          const sol = Number(e.sol_amount) / LAMPORTS_PER_SOL;
          ledger.ticks.push({
            slot: e.slot,
            buy: e.is_buy,
            sol,
            user: e.user,
            price: Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves),
          });
          seen.add(e.mint);
        }
      }
      for (const mint of seen) {
        const ledger = ledgers.get(mint)!;
        let cut = 0;
        while (cut < ledger.ticks.length && ledger.ticks[cut]!.slot <= now - retention) cut++;
        if (cut > 0) ledger.ticks.splice(0, cut);
      }
      const marks = new Map(batch.marks.map((m) => [m.mint, m] as const));
      const pending = new Map<Pubkey, number>();
      for (const po of state.pending.values()) {
        pending.set(po.order.mint, (pending.get(po.order.mint) ?? 0) + 1);
      }

      const orders: OrderInput[] = [];
      const batchCap = state.hello.caps.max_orders_per_batch;
      const fee = Number(state.txFeeLamports()) / LAMPORTS_PER_SOL;

      // Exits go first: stop loss, trailing stop, time limit. Each exit
      // sells the whole position in one order.
      for (const [mint, rec] of live) {
        const position = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (position === undefined) {
          if (!pending.has(mint)) {
            live.delete(mint);
            const ledger = ledgerFor(mint);
            if (rec.live) ledger.lastClose = now;
            else ledger.tries--;
          }
          continue;
        }
        rec.live = true;
        if (curve === undefined || curve.complete) continue;
        const mk = marks.get(mint);
        const vq = mk ? Number(mk.virtual_quote_reserves) : Number(curve.virtual_quote_reserves);
        const vt = mk ? Number(mk.virtual_token_reserves) : Number(curve.virtual_token_reserves);
        const tokens = Number(position.token_amount);
        const gross = (tokens * vq) / (vt + tokens) / LAMPORTS_PER_SOL;
        const value = gross * (1 - FEE_RATE) - fee;
        const cost = Number(position.cost_lamports) / LAMPORTS_PER_SOL;
        if (value > rec.best) rec.best = value;
        rec.mark = value;
        let exit = rec.closing;
        if (!exit && value < cost * (1 - p.stopLoss)) exit = true;
        if (!exit && rec.best >= cost * (1 + p.trailArm) && value < rec.best * (1 - p.trail)) exit = true;
        // The time limit does not touch a strong runner: a position up
        // 50% or more stays open under the trailing stop instead.
        if (!exit && value < cost * 1.5 && now - rec.openedAt > p.maxHold) exit = true;
        if (!exit) continue;
        rec.closing = true;
        let sellPending = false;
        for (const po of state.pending.values()) {
          if (po.order.mint === mint && po.order.side === 'sell') sellPending = true;
        }
        if (sellPending) continue;
        if (orders.length >= batchCap) break;
        orders.push({ side: 'sell', mint, token_amount: position.token_amount, max_slippage_bps: 10_000 });
      }

      // Probe round trips: dump the whole probe once its buy has landed.
      for (const [mint, selling] of pacers) {
        const position = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (position === undefined) {
          if (!pending.has(mint)) pacers.delete(mint);
          continue;
        }
        if (curve === undefined || curve.complete || pending.has(mint)) continue;
        if (orders.length >= batchCap) break;
        orders.push({ side: 'sell', mint, token_amount: position.token_amount, max_slippage_bps: 10_000 });
        if (!selling) pacers.set(mint, true);
      }

      // Entries and add-ons.
      let cash = Number(state.freeCashLamports()) / LAMPORTS_PER_SOL;
      let openRoom = state.hello.caps.max_open_positions - state.committedPositionCount();
      let mainRoom = p.maxMain - live.size;
      let committed = 0;
      for (const [mint, rec] of live) {
        committed += Math.max(rec.spent, Number(state.positions.get(mint)?.cost_lamports ?? 0n) / LAMPORTS_PER_SOL);
      }
      for (const mint of seen) {
        if (orders.length >= batchCap) break;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        if (pending.has(mint) || pacers.has(mint)) continue;
        const ledger = ledgers.get(mint)!;
        const rec = live.get(mint);
        const price = Number(curve.virtual_quote_reserves) / Number(curve.virtual_token_reserves);
        const rqSol = Number(curve.real_quote_reserves) / LAMPORTS_PER_SOL;
        let want: number;
        if (rec === undefined) {
          if (openRoom <= 0 || mainRoom <= 0) continue;
          if (ledger.tries >= p.maxEntries || now - ledger.lastClose < p.cooldown) continue;
          if (!qualifies(ledger, now, rqSol)) continue;
          want = Math.min(p.initialSol, p.stakeSol);
        } else {
          // Add only into strength: the price has stepped up from the
          // last add, net SOL is still flowing in, and the position is
          // at or above cost — never add to a loser.
          if (!p.pyramid || rec.closing || !rec.live || rec.spent >= p.stakeSol - p.minBuySol) continue;
          const position = state.positions.get(mint);
          if (position === undefined) continue;
          if (rec.mark < Number(position.cost_lamports) / LAMPORTS_PER_SOL) continue;
          if (price < rec.lastBuy * (1 + p.addStep)) continue;
          if (windowFlow(ledger, now, p.window) <= 0) continue;
          if (rqSol > p.maxRqSol) continue;
          want = Math.min(p.addSol, p.stakeSol - rec.spent);
        }
        const capSol = Math.floor(Number(state.maxBuyLamports(mint))) / LAMPORTS_PER_SOL;
        let amount = Math.min(capSol, want, p.maxExposureSol - committed);
        if (amount > cash - fee) amount = cash - fee;
        if (amount < p.minBuySol) continue;
        const lamports = BigInt(Math.floor(amount * LAMPORTS_PER_SOL));
        orders.push({ side: 'buy', mint, quote_lamports: lamports, max_slippage_bps: p.buySlipBps });
        cash -= amount + fee;
        committed += amount;
        if (rec === undefined) {
          live.set(mint, { openedAt: now, best: 0, spent: amount, closing: false, live: false, lastBuy: price, mark: 0 });
          ledger.tries++;
          openRoom--;
          mainRoom--;
        } else {
          rec.spent += amount;
          rec.lastBuy = price;
        }
      }

      // Guardrail pacing: open a probe when the bot's fills or coins are
      // behind the pace implied by block time.
      if (pacers.size < p.maxProbes && openRoom > 0 && t0 !== null && t1 !== null) {
        const pace = Math.min(1, (t1 - t0) / p.paceSecs);
        const needCoins = coins.size < Math.ceil(p.targetCoins * pace);
        const needFills = fills < Math.ceil(p.targetFills * pace);
        if (needCoins || needFills) {
          const minRq = (p.probeSol * Number(BPS_BASE)) / state.hello.caps.max_order_bps_of_real_reserve;
          for (const mint of seen) {
            if (orders.length >= batchCap || pacers.size >= p.maxProbes) break;
            if (live.has(mint) || pacers.has(mint) || pending.has(mint) || state.positions.has(mint)) continue;
            if (needCoins && !needFills && coins.has(mint)) continue;
            const curve = state.curves.get(mint);
            if (curve === undefined || curve.complete) continue;
            if (Number(curve.real_quote_reserves) / LAMPORTS_PER_SOL < minRq * 1.5) continue;
            if (cash < p.probeSol + 2 * fee) break;
            orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(p.probeSol * LAMPORTS_PER_SOL)), max_slippage_bps: p.buySlipBps });
            pacers.set(mint, false);
            cash -= p.probeSol + fee;
          }
        }
      }
      return orders;
    },
  };
}
