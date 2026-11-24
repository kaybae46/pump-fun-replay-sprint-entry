// Pump.fun Replay Sprint — paper bot (agent-fun/replay/v2).
//
// The grader runs `node /bot/main.ts`. The harness speaks hello, then one batch
// per slot, then done; this bot answers every batch with its orders (possibly
// none) and exits on done. The strategy lives in strategy.ts: trend-following
// entries on accelerating buy pressure, small first buys pyramided only into
// winners, whole-position exits on stop loss / trailing stop / time limit, plus
// tiny probe round trips that keep the run above the guardrails. The wire shim
// is the kit's sdk/ts/makefun-bot.ts, vendored byte for byte in vendor/.

import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy, DEFAULT_PARAMS } from './strategy.ts';

await runBot(createStrategy(DEFAULT_PARAMS));
