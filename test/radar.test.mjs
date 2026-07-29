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
