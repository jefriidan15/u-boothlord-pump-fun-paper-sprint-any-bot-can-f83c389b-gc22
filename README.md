# Pump.fun Paper Sprint: Any Bot Can Win — golden-condor-22

[![make.fun](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![make.fun rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/jefriidan15/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b-gc22/rank.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![make.fun reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/jefriidan15/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b-gc22/reward.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)

A mean-reversion paper-trading bot for the Pump.fun Paper Sprint. It paper-trades
pump.fun bonding curves on a 6-hour replay with 10 SOL of paper capital, ranked by
net PnL. Winner takes the whole $2 pot.

## Strategy

Buy sharp pullbacks, exit on a plan — never chase a launch:

- **Entry:** a coin whose price has fallen 10% or more below its recent peak
  (6% while the bot still needs breadth toward the 20-mint guardrail), with at
  least 4 trades behind it. Stakes are 0.30 SOL on a strong dip, 0.10 SOL on a
  shallow one. A peak older than 300 batches is stale and gets re-anchored.
- **Exit:** take profit at +9% over cost, stop-loss at -6%, or a trailing exit
  once up 4% and giving back 5 points from the peak since the buy.
- **Breadth:** at most 2 round trips per coin, at most 5 open positions, so
  capital cycles through at least 20 distinct mints at 0.02 SOL or more each.
- **Determinism:** no clock, no environment, no `Math.random` — every decision
  comes from the harness state alone, so the two graded executions agree
  byte for byte. All price math is bigint ratio arithmetic, no floats.
- **Costs:** a round trip pays ~95/30 bps in curve fees plus 5000/100000
  lamports per order, roughly 2.5% — the 9% profit target and 6% stop sit
  wide of that on purpose.

## Layout

- `main.ts` — the strategy (Node 22, run by the grader as `node /bot/main.ts`).
- `vendor/makefun-bot.ts` — the kit's `agent-fun/replay/v2` shim, byte-identical
  to `sdk/ts/makefun-bot.ts`, vendored beside the entrypoint.

## Grade locally

```sh
node <kit>/cli/makefun.mjs grade-local --kit <kit> --bot . --driver docker --bundle transcripts.tar.gz
```
