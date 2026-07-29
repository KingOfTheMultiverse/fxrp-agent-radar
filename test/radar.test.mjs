/** Scoring-logic checks. Pure functions only — no network. */
import assert from 'node:assert/strict';
import { collateralBuffer, backingSurplus, scoreAgent, warnings } from '../src/radar.mjs';

// collateralBuffer: distance above the liquidation line, relative to the line.
assert.equal(collateralBuffer(24000n, 12000n), 1.0, 'double the minimum is a 100% buffer');
assert.equal(collateralBuffer(12000n, 12000n), 0, 'sitting on the line is zero buffer');
assert.ok(collateralBuffer(11000n, 12000n) < 0, 'below the line must be negative');
assert.equal(collateralBuffer(12000n, 0n), 0, 'no threshold must not divide by zero');

// backingSurplus: does the agent actually hold the XRP it owes?
assert.equal(backingSurplus(200n, 100n), 1.0, 'double the owed amount is +100%');
assert.equal(backingSurplus(100n, 100n), 0, 'exactly covered is zero surplus');
assert.ok(backingSurplus(90n, 100n) < 0, 'under-backed must be negative');
assert.equal(backingSurplus(0n, 0n), 1, 'owing nothing counts as fully backed');

const healthy = {
  status: 'NORMAL', vaultBuffer: 1.0, poolBuffer: 1.0,
  backingSurplus: 0.5, freeLots: 100, feeBIPS: 0,
};
assert.equal(scoreAgent(healthy), 100, 'a maximally healthy agent scores 100');

// Safety must dominate price: never prefer a cheap agent that is nearly liquidating.
const cheapButRisky = { ...healthy, vaultBuffer: 0.02, poolBuffer: 0.02, backingSurplus: 0, feeBIPS: 0 };
const pricedButSafe = { ...healthy, feeBIPS: 50 };
assert.ok(scoreAgent(pricedButSafe) > scoreAgent(cheapButRisky),
  'a safe agent charging a fee must outrank a free agent near liquidation');

// Any non-normal status is disqualifying regardless of other metrics.
assert.equal(scoreAgent({ ...healthy, status: 'LIQUIDATION' }), 0, 'liquidating agents score 0');
assert.equal(scoreAgent({ ...healthy, status: 'CCB' }), 0, 'CCB agents score 0');

// Under-backing is the risk users cannot currently see — it must always warn.
const under = { ...healthy, backingSurplus: -0.2 };
assert.ok(warnings(under).some((w) => /redemption may default/.test(w)),
  'under-backed agent must warn about redemption default');
assert.ok(warnings({ ...healthy, vaultBuffer: 0.05 }).some((w) => /liquidation threshold/.test(w)),
  'thin vault collateral must warn');
assert.equal(warnings(healthy).length, 0, 'a healthy agent produces no warnings');

console.log('radar tests passed');

// --- stress path -------------------------------------------------------------
import { stressPath } from '../src/radar.mjs';
const live = {
  status: 'NORMAL', vaultBuffer: 5.0, poolBuffer: 6.0,
  backingSurplus: 2.4, freeLots: 850, feeBIPS: 25,
};
const path = stressPath(live);
assert.equal(path.length, 7, 'default stress path has 7 points');
assert.equal(path[0].score, scoreAgent(live), 'step 0 must reproduce the live score');
assert.ok(path.at(-1).score < path[0].score, 'score must fall as collateral degrades');
assert.ok(path.at(-1).backingSurplus < 0, 'the end of the path must go under-backed');
assert.ok(path.at(-1).warnings.some((w) => /redemption may default/.test(w)),
  'the stressed end state must raise the redemption-default warning');
for (let i = 1; i < path.length; i++) {
  assert.ok(path[i].score <= path[i - 1].score, 'score must be monotonically non-increasing under stress');
}
console.log('stress-path tests passed');

// --- redemption queue preview ------------------------------------------------
import { previewRedemption } from '../src/radar.mjs';
const LOT = 10_000_000n; // 10 XRP at 6dp
const byAgent = {
  '0xaaa': { address: '0xAAA', backingSurplus: 1.2, status: 'NORMAL' },
  '0xbbb': { address: '0xBBB', backingSurplus: -0.3, status: 'NORMAL' }, // under-backed
};
const queue = [
  { agentVault: '0xAAA', ticketValueUBA: 10_000_000n }, // 1 lot
  { agentVault: '0xBBB', ticketValueUBA: 30_000_000n }, // 3 lots
  { agentVault: '0xAAA', ticketValueUBA: 50_000_000n },
];

// FIFO: 2 lots must come from the first ticket then spill into the second.
const p = previewRedemption(queue, byAgent, 2, LOT);
assert.equal(p.requestedXRP, 20, 'two lots is 20 XRP');
assert.equal(p.filledXRP, 20, 'queue is deep enough to fill it');
assert.equal(p.shortfallXRP, 0, 'no shortfall expected');
assert.equal(p.fills.length, 2, 'the fill spans both agents');
assert.equal(p.atRiskXRP, 10, 'the half served by the under-backed agent is at risk');
assert.ok(Math.abs(p.atRiskShare - 0.5) < 1e-9, 'at-risk share is one half');

// Order matters: 1 lot comes entirely from the healthy agent at the head.
const one = previewRedemption(queue, byAgent, 1, LOT);
assert.equal(one.fills.length, 1, 'one lot is served by a single ticket');
assert.equal(one.atRiskXRP, 0, 'head of queue is healthy, so nothing at risk');

// A queue shallower than the request must report the shortfall, not silently fill.
const shallow = previewRedemption([{ agentVault: '0xAAA', ticketValueUBA: 10_000_000n }], byAgent, 5, LOT);
assert.equal(shallow.filledXRP, 10, 'only what the queue holds is filled');
assert.equal(shallow.shortfallXRP, 40, 'the rest is reported as shortfall');

console.log('redemption-preview tests passed');

// The protocol caps tickets consumed per redemption; a request spanning more than that
// is only partly filled, and that is recoverable by redeeming again — unlike a queue
// that has genuinely run dry. The two must not look the same.
const manyTickets = Array.from({ length: 30 }, () => ({ agentVault: '0xAAA', ticketValueUBA: 10_000_000n }));
const capped = previewRedemption(manyTickets, byAgent, 30, LOT, 20);
assert.equal(capped.ticketsUsed, 20, 'must stop at the ticket cap');
assert.equal(capped.filledXRP, 200, 'only 20 tickets worth is filled in one transaction');
assert.equal(capped.shortfallXRP, 100, 'the rest is left unfilled');
assert.equal(capped.cappedByTickets, true, 'shortfall here is the ticket cap, not a dry queue');

const dry = previewRedemption([{ agentVault: '0xAAA', ticketValueUBA: 10_000_000n }], byAgent, 5, LOT, 20);
assert.equal(dry.cappedByTickets, false, 'a shallow queue is not a ticket-cap shortfall');

const within = previewRedemption(manyTickets, byAgent, 5, LOT, 20);
assert.equal(within.cappedByTickets, false, 'a request inside the cap is not capped');
assert.equal(within.shortfallXRP, 0, 'and has no shortfall');

console.log('ticket-cap tests passed');
