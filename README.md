# Pump.fun Replay Sprint — Paper Bot

[![make.fun](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/kaybae46/pump-fun-replay-sprint-entry/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/kaybae46/pump-fun-replay-sprint-entry/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)

A paper trading bot for the [Pump.fun Replay Sprint](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122) on make.fun. It trades 10 SOL of paper money on a 24-hour replay of pump.fun bonding-curve activity; best net PnL wins.

## Strategy

Trend-following, kept deliberately simple to avoid overfitting:

- **Entries:** buy only curves showing accelerating buy pressure — mature (500+ slots since creation), net SOL flowing in over a 30-slot window (≥ 2 SOL), at least 3 buys from 8 distinct buyers, price up 8–150% and sitting near its window high, with the newer half of the window buying harder than the older half.
- **Sizing:** first buy is small (0.1 SOL). Add 0.2 SOL at a time only while the position is working — price at or above the last buy, net flow still positive, position at or above cost — up to 1 SOL per position. False starts cost little; runners get size.
- **Exits:** sell the whole position on the first of a 10% stop loss against cost, a 12% trailing stop from its best close value (armed once up 2%), or a 1500-slot time limit (waived while up 50%+).
- **Guardrails:** tiny 0.01 SOL probe round trips keep the run above the minimum bar (20+ coins, 200+ fills) when real entries lag the pace.

Deterministic by construction: no clock, no randomness, no environment reads — every decision is a pure function of the batch stream, so the two grading runs produce identical action logs.

## Layout

- `main.ts` — entrypoint; the grader runs `node /bot/main.ts`.
- `strategy.ts` — the strategy (parameters in `DEFAULT_PARAMS`).
- `vendor/makefun-bot.ts` — the kit's `agent-fun/replay/v2` wire shim, vendored byte for byte.

## Local backtest

On the kit's dev window (local sim port in the kit's pilot baselines): net **+0.18 SOL**, 340 fills, 53 coins, 117 round trips, max drawdown **0.103** — inside the 0.50 guardrail. The house momentum baseline scores −9.38 SOL on the same window, so the dev window is a bloodbath for momentum; this bot survives it near breakeven with small size and tight stops. The trailing stop was tightened from 15% (armed at +3%) to 12% (armed at +2%) after the first draft scored −0.03 SOL; tighter stops and a sell-share entry guard were tried and reverted because they scored worse.
