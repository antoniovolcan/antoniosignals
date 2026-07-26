import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLedger, updateLedgerFromPlateAppearances, getBatterLedgerProfile, computeBucketStats } from './battingLedger.js';

function pa(overrides) {
  return { inning: 1, halfInning: 'top', event: 'Single', description: '', rbi: 0, batterId: 1, batterName: 'Test Batter', batSide: 'R', pitcherId: 9, pitcherName: 'Test Pitcher', pitchHand: 'R', ...overrides };
}

test('updateLedgerFromPlateAppearances: a single vs. a right-handed pitcher counts as an AB and a hit in the R bucket only', () => {
  const ledger = createLedger();
  updateLedgerFromPlateAppearances(ledger, [pa({ event: 'Single', pitchHand: 'R' })]);
  const profile = getBatterLedgerProfile(ledger, 1, 'R');
  assert.equal(profile.vsHand.ab, 1);
  assert.equal(profile.vsHand.hits, 1);
  assert.equal(profile.vsHand.avg, 1);
  const lefty = getBatterLedgerProfile(ledger, 1, 'L');
  assert.equal(lefty.vsHand, null);
});

test('updateLedgerFromPlateAppearances: walks and HBP count as a plate appearance but not an at-bat', () => {
  const ledger = createLedger();
  updateLedgerFromPlateAppearances(ledger, [pa({ event: 'Walk' }), pa({ event: 'Hit By Pitch' })]);
  const profile = getBatterLedgerProfile(ledger, 1, 'R');
  assert.equal(profile.vsHand.pa, 2);
  assert.equal(profile.vsHand.ab, 0);
  assert.equal(profile.vsHand.avg, 0); // ab=0 falls back to 0, not NaN
});

test('updateLedgerFromPlateAppearances: a home run counts as a hit, 4 total bases, and increments HR rate', () => {
  const ledger = createLedger();
  updateLedgerFromPlateAppearances(ledger, [pa({ event: 'Home Run' })]);
  const profile = getBatterLedgerProfile(ledger, 1, 'R');
  assert.equal(profile.vsHand.hr, 1);
  assert.equal(profile.vsHand.slg, 4);
  assert.ok(Math.abs(profile.vsHand.hrRate - 1.0) < 1e-9);
});

test('updateLedgerFromPlateAppearances: an out (e.g. groundout) counts as an AB but not a hit', () => {
  const ledger = createLedger();
  updateLedgerFromPlateAppearances(ledger, [pa({ event: 'Groundout' })]);
  const profile = getBatterLedgerProfile(ledger, 1, 'R');
  assert.equal(profile.vsHand.ab, 1);
  assert.equal(profile.vsHand.hits, 0);
  assert.equal(profile.vsHand.avg, 0);
});

test('updateLedgerFromPlateAppearances: skips plate appearances with no known pitch hand', () => {
  const ledger = createLedger();
  updateLedgerFromPlateAppearances(ledger, [pa({ pitchHand: null })]);
  assert.equal(ledger.size, 0);
});

test('getBatterLedgerProfile: overall combines both hand buckets', () => {
  const ledger = createLedger();
  updateLedgerFromPlateAppearances(ledger, [
    pa({ event: 'Single', pitchHand: 'R' }),
    pa({ event: 'Single', pitchHand: 'L' }),
    pa({ event: 'Groundout', pitchHand: 'R' }),
  ]);
  const profile = getBatterLedgerProfile(ledger, 1, 'R');
  assert.equal(profile.vsHand.ab, 2);
  assert.equal(profile.vsHand.hits, 1);
  assert.equal(profile.overall.ab, 3);
  assert.equal(profile.overall.hits, 2);
});

test('getBatterLedgerProfile: accumulates across multiple calls (simulating multiple games over time)', () => {
  const ledger = createLedger();
  updateLedgerFromPlateAppearances(ledger, [pa({ event: 'Single' })]);
  updateLedgerFromPlateAppearances(ledger, [pa({ event: 'Strikeout' })]);
  const profile = getBatterLedgerProfile(ledger, 1, 'R');
  assert.equal(profile.vsHand.pa, 2);
  assert.equal(profile.vsHand.ab, 2);
  assert.equal(profile.vsHand.hits, 1);
  assert.ok(Math.abs(profile.vsHand.strikeoutRate - 0.5) < 1e-9);
});

test('getBatterLedgerProfile: returns null for a batter with no plate appearances recorded yet', () => {
  const ledger = createLedger();
  assert.equal(getBatterLedgerProfile(ledger, 999, 'R'), null);
});

test('computeBucketStats: returns null for an empty bucket', () => {
  assert.equal(computeBucketStats({ pa: 0, ab: 0, hits: 0, hr: 0, totalBases: 0, walks: 0, hbp: 0, strikeouts: 0 }), null);
});

test('computeBucketStats: OPS is the sum of OBP and SLG', () => {
  const ledger = createLedger();
  updateLedgerFromPlateAppearances(ledger, [pa({ event: 'Double' }), pa({ event: 'Walk' }), pa({ event: 'Groundout' })]);
  const profile = getBatterLedgerProfile(ledger, 1, 'R');
  // ab=2 (double, groundout), pa=3, hits=1, totalBases=2, walks=1
  const expectedObp = (1 + 1 + 0) / 3;
  const expectedSlg = 2 / 2;
  assert.ok(Math.abs(profile.vsHand.ops - (expectedObp + expectedSlg)) < 1e-9);
});
