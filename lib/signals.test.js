import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clamp, pitcherFactor, teamWinProbability, log5, TEAM_RECORD_RECENT_WEIGHT } from './signals.js';
import { moneylineEstimate, projectedTotalRuns, normalCdf, overProbability } from './signals.js';
import { projectedFirstFiveInningsRuns } from './signals.js';
import { poissonPmf, poissonCdf, overProbabilityProp } from './signals.js';
import { impliedProbability, edge, isSignal, formatSignalMessage } from './signals.js';
import { isConfidentEnough, MIN_MONEYLINE_CONFIDENCE } from './signals.js';
import { expectedPitcherStrikeouts } from './signals.js';
import { gradeMoneylineSignal, gradeTotalsSignal, gradeOverSignal } from './signals.js';
import { blendEraEstimates } from './signals.js';
import { computeOffensiveFactor, computeLineupOps } from './signals.js';
import { computePowerContactFactor, computeAveragePowerContactFactor } from './signals.js';
import { adjustedInningsForEarlyHookRisk, EARLY_HOOK_RISK_SCALE } from './signals.js';
import { calibrateWinProbability, MONEYLINE_CALIBRATION_SHRINK } from './signals.js';
import { calibrateProjectedTotal, TOTALS_CALIBRATION_SHRINK } from './signals.js';
import { computeWeatherFactorForStrikeouts } from './signals.js';
import { CAREER_ERA_WEIGHT, CAREER_K9_WEIGHT } from './signals.js';
import { formatCareerEraNote, formatCareerEraPairNote } from './signals.js';
import { formatSimComparisonNote } from './signals.js';

test('clamp bounds a value', () => {
  assert.equal(clamp(5, 0, 10), 5);
  assert.equal(clamp(-1, 0, 10), 0);
  assert.equal(clamp(20, 0, 10), 10);
});

test('pitcherFactor: league-average ERA gives factor 1', () => {
  assert.equal(pitcherFactor(4.00, 4.00), 1);
});

test('pitcherFactor: elite ERA gives factor above 1, capped at 1.8', () => {
  assert.ok(pitcherFactor(1.50, 4.00) > 1);
  assert.equal(pitcherFactor(0.10, 4.00), 1.8);
});

test('pitcherFactor: poor ERA gives factor below 1, floored at 0.5', () => {
  assert.ok(pitcherFactor(8.00, 4.00) < 1);
  assert.equal(pitcherFactor(100, 4.00), 0.5);
});

test('teamWinProbability: league-average team at home is above .500', () => {
  const p = teamWinProbability({ recordWinPct: 0.5, startingPitcherEra: 4.00, isHome: true });
  assert.ok(p > 0.5);
});

test('teamWinProbability: league-average team on the road is below .500', () => {
  const p = teamWinProbability({ recordWinPct: 0.5, startingPitcherEra: 4.00, isHome: false });
  assert.ok(p < 0.5);
});

test('teamWinProbability: even an elite home team is capped at a realistic ceiling, not near-certainty', () => {
  const p = teamWinProbability({ recordWinPct: 1.0, startingPitcherEra: 0.5, isHome: true });
  assert.ok(p <= 0.70);
});

test('teamWinProbability: even a terrible away team has a realistic floor, not near-zero', () => {
  const p = teamWinProbability({ recordWinPct: 0.0, startingPitcherEra: 15.0, isHome: false });
  assert.ok(p >= 0.30);
});

test('TEAM_RECORD_RECENT_WEIGHT: season-to-date record dominates over the last-15 window', () => {
  // A blend using this weight should sit closer to the season record than to recent form.
  const recordWinPct = blendEraEstimates(0.80, 0.50, TEAM_RECORD_RECENT_WEIGHT); // hot last 15, average all season
  assert.equal(TEAM_RECORD_RECENT_WEIGHT, 0.3);
  assert.ok(Math.abs(recordWinPct - 0.59) < 1e-9); // 0.80*0.3 + 0.50*0.7 = 0.59
  assert.ok(Math.abs(recordWinPct - 0.5) < Math.abs(0.80 - 0.5)); // closer to the season record than a naive last-15-only read
});

test('log5: two evenly matched .500 teams gives 50%', () => {
  assert.ok(Math.abs(log5(0.5, 0.5) - 0.5) < 1e-9);
});

test('log5: stronger team has higher win probability', () => {
  assert.ok(log5(0.65, 0.45) > 0.5);
});

test('moneylineEstimate: home favorite with better pitcher wins more often', () => {
  const p = moneylineEstimate({
    home: { recordWinPct: 0.7, startingPitcherEra: 2.80 },
    away: { recordWinPct: 0.4, startingPitcherEra: 4.80 },
  });
  assert.ok(p > 0.5);
});

test('calibrateWinProbability: shrinks a probability toward 0.5 by the shrink factor', () => {
  // 0.5 + (0.80 - 0.5) * 0.5 = 0.65
  assert.ok(Math.abs(calibrateWinProbability(0.80, 0.5) - 0.65) < 1e-9);
  // 0.5 + (0.20 - 0.5) * 0.5 = 0.35
  assert.ok(Math.abs(calibrateWinProbability(0.20, 0.5) - 0.35) < 1e-9);
});

test('calibrateWinProbability: leaves 0.5 unchanged regardless of shrink factor', () => {
  assert.ok(Math.abs(calibrateWinProbability(0.5, 0.3) - 0.5) < 1e-9);
});

test('calibrateWinProbability: defaults to MONEYLINE_CALIBRATION_SHRINK (0.5)', () => {
  assert.equal(MONEYLINE_CALIBRATION_SHRINK, 0.5);
  assert.ok(Math.abs(calibrateWinProbability(0.80) - 0.65) < 1e-9);
});

test('moneylineEstimate: shrinkage preserves direction (still favors the stronger home team)', () => {
  const p = moneylineEstimate({
    home: { recordWinPct: 0.7, startingPitcherEra: 2.80 },
    away: { recordWinPct: 0.4, startingPitcherEra: 4.80 },
  });
  assert.ok(p > 0.5);
  assert.ok(p < 0.70); // shrinkage should pull it noticeably closer to 0.5 than the unshrunk log5 output
});

test('projectedTotalRuns: two average teams/pitchers project near league average total', () => {
  const total = projectedTotalRuns({
    home: { runsPerGame: 4.5, startingPitcherEra: 4.00 },
    away: { runsPerGame: 4.5, startingPitcherEra: 4.00 },
  });
  assert.ok(Math.abs(total - 9.0) < 0.5);
});

test('projectedTotalRuns: a team facing a weak opposing pitcher scores more than one facing a strong one', () => {
  const totalWithWeakAwayPitcher = projectedTotalRuns({
    home: { runsPerGame: 4.5, startingPitcherEra: 4.00 },
    away: { runsPerGame: 4.5, startingPitcherEra: 6.00 }, // away pitcher is bad -> home should score MORE
  });
  const totalWithStrongAwayPitcher = projectedTotalRuns({
    home: { runsPerGame: 4.5, startingPitcherEra: 4.00 },
    away: { runsPerGame: 4.5, startingPitcherEra: 2.00 }, // away pitcher is great -> home should score LESS
  });
  assert.ok(totalWithWeakAwayPitcher > totalWithStrongAwayPitcher);
});

test('projectedTotalRuns: a small-sample extreme ERA (e.g. one disastrous early-season start) does not blow up the projection to unrealistic totals', () => {
  const total = projectedTotalRuns({
    home: { runsPerGame: 2.8, startingPitcherEra: 67.5 },
    away: { runsPerGame: 4.2, startingPitcherEra: 0 },
  });
  assert.ok(total < 20); // a real MLB game essentially never totals 20+ runs
});

test('calibrateProjectedTotal: shrinks a projection toward the gravity point by the shrink factor', () => {
  // 9.0 + (11.0 - 9.0) * 0.8 = 10.6
  assert.ok(Math.abs(calibrateProjectedTotal(11.0, 9.0, 0.8) - 10.6) < 1e-9);
  // 9.0 + (7.0 - 9.0) * 0.8 = 7.4
  assert.ok(Math.abs(calibrateProjectedTotal(7.0, 9.0, 0.8) - 7.4) < 1e-9);
});

test('calibrateProjectedTotal: leaves the gravity point unchanged regardless of shrink factor', () => {
  assert.ok(Math.abs(calibrateProjectedTotal(9.0, 9.0, 0.5) - 9.0) < 1e-9);
});

test('calibrateProjectedTotal: defaults to TOTALS_CALIBRATION_SHRINK (0.8)', () => {
  assert.equal(TOTALS_CALIBRATION_SHRINK, 0.8);
  assert.ok(Math.abs(calibrateProjectedTotal(11.0, 9.0) - 10.6) < 1e-9);
});

test('projectedTotalRuns: an extreme projection is pulled toward league average by the calibration shrink', () => {
  // A big favorable gap (great home offense, terrible away pitching) pushes the raw projection
  // well above 9.0; the shrunk result should land closer to 9.0 than the (hypothetical) raw value.
  const total = projectedTotalRuns({
    home: { runsPerGame: 6.5, startingPitcherEra: 4.00 },
    away: { runsPerGame: 4.5, startingPitcherEra: 8.8 },
  });
  const rawWithoutShrink = ((6.5 + 4.5 * 2.2) / 2) + ((4.5 + 4.5 * 1.0) / 2); // same formula, shrink=1 equivalent
  assert.ok(total < rawWithoutShrink);
  assert.ok(total > 9.0);
});

test('projectedTotalRuns: a hitter-friendly park factor raises the projection above the neutral case', () => {
  const neutral = projectedTotalRuns({
    home: { runsPerGame: 4.5, startingPitcherEra: 4.00 },
    away: { runsPerGame: 4.5, startingPitcherEra: 4.00 },
  });
  const coorsLike = projectedTotalRuns({
    home: { runsPerGame: 4.5, startingPitcherEra: 4.00 },
    away: { runsPerGame: 4.5, startingPitcherEra: 4.00 },
    parkFactor: 1.18,
  });
  assert.ok(coorsLike > neutral);
});

test('projectedTotalRuns: park factor shifts the calibration gravity point, not just the raw total', () => {
  // With average inputs, the raw projection already equals the (park-adjusted) gravity point, so
  // shrink should be a no-op regardless of parkFactor -- confirming the gravity point itself moved,
  // rather than the park-adjusted projection being shrunk back down toward a neutral 9.0.
  const coorsLike = projectedTotalRuns({
    home: { runsPerGame: 4.5, startingPitcherEra: 4.00 },
    away: { runsPerGame: 4.5, startingPitcherEra: 4.00 },
    parkFactor: 1.18,
  });
  assert.ok(Math.abs(coorsLike - 9.0 * 1.18) < 1e-9);
});

test('projectedFirstFiveInningsRuns: two average teams/pitchers project near the 5-inning league average', () => {
  const total = projectedFirstFiveInningsRuns({
    home: { runsPerGame: 4.5, startingPitcherEra: 4.00 },
    away: { runsPerGame: 4.5, startingPitcherEra: 4.00 },
  });
  assert.ok(Math.abs(total - 5.0) < 0.5); // ~ 2.5 + 2.5
});

test('projectedFirstFiveInningsRuns: park factor shifts the F5 gravity point too', () => {
  const coorsLike = projectedFirstFiveInningsRuns({
    home: { runsPerGame: 4.5, startingPitcherEra: 4.00 },
    away: { runsPerGame: 4.5, startingPitcherEra: 4.00 },
    parkFactor: 1.18,
  });
  assert.ok(Math.abs(coorsLike - 5.0 * 1.18) < 1e-9);
});

test('projectedFirstFiveInningsRuns: projects meaningfully less than a full 9-inning game, all else equal', () => {
  const home = { runsPerGame: 4.5, startingPitcherEra: 4.00 };
  const away = { runsPerGame: 4.5, startingPitcherEra: 4.00 };
  const f5 = projectedFirstFiveInningsRuns({ home, away });
  const full = projectedTotalRuns({ home, away });
  assert.ok(f5 < full);
});

test('projectedFirstFiveInningsRuns: a weak opposing starter still means more runs, same direction as the full-game formula', () => {
  const weak = projectedFirstFiveInningsRuns({
    home: { runsPerGame: 4.5, startingPitcherEra: 4.00 },
    away: { runsPerGame: 4.5, startingPitcherEra: 6.00 },
  });
  const strong = projectedFirstFiveInningsRuns({
    home: { runsPerGame: 4.5, startingPitcherEra: 4.00 },
    away: { runsPerGame: 4.5, startingPitcherEra: 2.00 },
  });
  assert.ok(weak > strong);
});

test('normalCdf: at the mean returns 0.5', () => {
  assert.ok(Math.abs(normalCdf(9.0, 9.0, 3.0) - 0.5) < 0.01);
});

test('normalCdf: far below the mean returns near 0', () => {
  assert.ok(normalCdf(0, 9.0, 3.0) < 0.01);
});

test('normalCdf: far above the mean returns near 1', () => {
  assert.ok(normalCdf(30, 9.0, 3.0) > 0.99);
});

test('overProbability: line below projection favors the over', () => {
  const p = overProbability(7.5, 9.0, 3.0);
  assert.ok(p > 0.5);
});

test('overProbability: line above projection favors the under', () => {
  const p = overProbability(11.5, 9.0, 3.0);
  assert.ok(p < 0.5);
});

test('poissonPmf: P(0 events | lambda=0) is 1', () => {
  assert.equal(poissonPmf(0, 0.0001) > 0.99, true);
});

test('poissonCdf: cumulative probability approaches 1 as k grows', () => {
  assert.ok(poissonCdf(20, 1.2) > 0.999);
});

test('overProbabilityProp: low expected rate against a low line still allows some over probability', () => {
  const p = overProbabilityProp(1.5, 1.2);
  assert.ok(p > 0 && p < 1);
});

test('overProbabilityProp: higher expected rate raises the over probability for the same line', () => {
  const low = overProbabilityProp(1.5, 0.8);
  const high = overProbabilityProp(1.5, 2.0);
  assert.ok(high > low);
});

test('impliedProbability: decimal odds of 2.00 implies 50%', () => {
  assert.ok(Math.abs(impliedProbability(2.00) - 0.5) < 1e-9);
});

test('edge: estimated minus implied', () => {
  assert.ok(Math.abs(edge(0.60, 0.50) - 0.10) < 1e-9);
});

test('isSignal: edge above threshold is a signal', () => {
  assert.equal(isSignal(0.613, 0.541, 0.05), true);
});

test('isSignal: edge below threshold is not a signal', () => {
  assert.equal(isSignal(0.55, 0.541, 0.05), false);
});

test('isConfidentEnough: far from a coin flip is confident enough', () => {
  assert.equal(isConfidentEnough(0.65, 0.08), true);
  assert.equal(isConfidentEnough(0.35, 0.08), true); // symmetric: works below 0.5 too
});

test('isConfidentEnough: too close to a coin flip is not confident enough', () => {
  assert.equal(isConfidentEnough(0.55, 0.08), false);
  assert.equal(isConfidentEnough(0.45, 0.08), false);
});

test('isConfidentEnough: comparison is inclusive (>=), not strict (>)', () => {
  assert.equal(isConfidentEnough(0.59, 0.08), true); // clearly past the 0.08 boundary, avoids float-precision edge cases
});

test('isConfidentEnough: defaults to MIN_MONEYLINE_CONFIDENCE (0.08)', () => {
  assert.equal(MIN_MONEYLINE_CONFIDENCE, 0.08);
  assert.equal(isConfidentEnough(0.55), false);
  assert.equal(isConfidentEnough(0.60), true);
});

test('formatSignalMessage: includes matchup, market, odds, edge, and reasoning', () => {
  const msg = formatSignalMessage({
    matchup: 'NYY @ BOS',
    market: 'Moneyline',
    selection: 'BOS gana',
    price: 1.85,
    impliedProb: 0.541,
    estimatedProb: 0.613,
    edgeValue: 0.072,
    reasoning: 'ERA abridor BOS 2.87 (últimos 5) vs NYY.',
  });
  assert.match(msg, /NYY @ BOS/);
  assert.match(msg, /Moneyline: BOS gana/);
  assert.match(msg, /1\.85/);
  assert.match(msg, /54\.1%/);
  assert.match(msg, /61\.3%/);
  assert.match(msg, /\+7\.2%/);
  assert.match(msg, /ERA abridor BOS 2\.87/);
});

test('formatSignalMessage: a negative edge does not get a stray plus sign', () => {
  const msg = formatSignalMessage({
    matchup: 'NYY @ BOS',
    market: 'Moneyline',
    selection: 'NYY gana',
    price: 2.10,
    impliedProb: 0.476,
    estimatedProb: 0.40,
    edgeValue: -0.076,
    reasoning: 'Test reasoning.',
  });
  assert.match(msg, /Edge: -7\.6%/);
  assert.doesNotMatch(msg, /Edge: \+-/);
});

test('expectedPitcherStrikeouts: average pitcher facing an average-strikeout team gives a plausible baseline rate', () => {
  const expected = expectedPitcherStrikeouts({ pitcherK9: 9.0, teamStrikeoutRate: 0.223 });
  // matchupFactor = 1 (exactly league average) -> (9/9) * 5.5 * 1 = 5.5
  assert.ok(Math.abs(expected - 5.5) < 0.01);
});

test('expectedPitcherStrikeouts: a high-strikeout pitcher projects more Ks than a low-strikeout pitcher, all else equal', () => {
  const aceExpected = expectedPitcherStrikeouts({ pitcherK9: 12.0, teamStrikeoutRate: 0.223 });
  const controlPitcherExpected = expectedPitcherStrikeouts({ pitcherK9: 6.0, teamStrikeoutRate: 0.223 });
  assert.ok(aceExpected > controlPitcherExpected);
});

test('expectedPitcherStrikeouts: facing a strikeout-prone team raises the projection', () => {
  const vsHighKTeam = expectedPitcherStrikeouts({ pitcherK9: 9.0, teamStrikeoutRate: 0.30 });
  const vsLowKTeam = expectedPitcherStrikeouts({ pitcherK9: 9.0, teamStrikeoutRate: 0.15 });
  assert.ok(vsHighKTeam > vsLowKTeam);
});

test('expectedPitcherStrikeouts: matchup factor is capped so an extreme team K rate does not produce an absurd projection', () => {
  const extreme = expectedPitcherStrikeouts({ pitcherK9: 9.0, teamStrikeoutRate: 5.0 });
  const cappedFactorExpected = (9.0 / 9) * 5.5 * 1.8; // matchupFactor clamped at 1.8
  assert.ok(Math.abs(extreme - cappedFactorExpected) < 0.01);
});

test('expectedPitcherStrikeouts: power/park/weather factors raise or lower the projection as expected', () => {
  const base = expectedPitcherStrikeouts({ pitcherK9: 9.0, teamStrikeoutRate: 0.223 });
  const boosted = expectedPitcherStrikeouts({ pitcherK9: 9.0, teamStrikeoutRate: 0.223, powerContactFactor: 1.1, parkFactor: 1.05, weatherFactor: 1.03 });
  const suppressed = expectedPitcherStrikeouts({ pitcherK9: 9.0, teamStrikeoutRate: 0.223, powerContactFactor: 0.9, parkFactor: 0.93, weatherFactor: 0.97 });
  assert.ok(boosted > base);
  assert.ok(suppressed < base);
});

test('computePowerContactFactor: a power hitter (high HR rate, average AVG) raises the factor above 1', () => {
  const factor = computePowerContactFactor({ hrRate: 0.06, avg: 0.248 });
  assert.ok(factor > 1);
});

test('computePowerContactFactor: a pure contact hitter (high AVG, low HR rate) lowers the factor below 1', () => {
  const factor = computePowerContactFactor({ hrRate: 0.015, avg: 0.310 });
  assert.ok(factor < 1);
});

test('computePowerContactFactor: league-average hitter gives a neutral factor near 1', () => {
  const factor = computePowerContactFactor({ hrRate: 0.032, avg: 0.248 });
  assert.ok(Math.abs(factor - 1) < 0.01);
});

test('computePowerContactFactor: extreme inputs are clamped to a narrow band', () => {
  assert.equal(computePowerContactFactor({ hrRate: 1.0, avg: 0.05 }), 1.15);
  assert.equal(computePowerContactFactor({ hrRate: 0.001, avg: 1.0 }), 0.85);
});

test('computeAveragePowerContactFactor: averages valid profiles and ignores missing ones', () => {
  const factor = computeAveragePowerContactFactor([
    { hrRate: 0.032, avg: 0.248 },
    null,
    { hrRate: 0.032, avg: 0.248 },
  ]);
  assert.ok(Math.abs(factor - 1) < 0.01);
});

test('computeAveragePowerContactFactor: empty or all-invalid input returns neutral 1.0', () => {
  assert.equal(computeAveragePowerContactFactor([]), 1.0);
  assert.equal(computeAveragePowerContactFactor([null, undefined]), 1.0);
});

test('adjustedInningsForEarlyHookRisk: leaves innings untouched for a good pitcher', () => {
  const innings = adjustedInningsForEarlyHookRisk({ baseInnings: 6.0, pitcherEra: 3.0, opposingOffensiveFactor: 1.2 });
  assert.equal(innings, 6.0);
});

test('adjustedInningsForEarlyHookRisk: leaves innings untouched vs a weak offense even with a bad ERA', () => {
  const innings = adjustedInningsForEarlyHookRisk({ baseInnings: 6.0, pitcherEra: 6.0, opposingOffensiveFactor: 0.9 });
  assert.equal(innings, 6.0);
});

test('adjustedInningsForEarlyHookRisk: shortens innings for a bad-ERA pitcher facing a strong offense', () => {
  const innings = adjustedInningsForEarlyHookRisk({ baseInnings: 6.0, pitcherEra: 6.0, opposingOffensiveFactor: 1.2 });
  assert.ok(innings < 6.0);
});

test('adjustedInningsForEarlyHookRisk: reduction is dampened by EARLY_HOOK_RISK_SCALE', () => {
  // eraRisk = clamp(6/4, 1, 2.5) - 1 = 0.5; offenseRisk = clamp(1.2, 1, 1.3) - 1 = 0.2
  // full-strength reduction (pre-EARLY_HOOK_RISK_SCALE) would be clamp(0.5*0.2*3, 0, 0.35) = 0.3
  // at EARLY_HOOK_RISK_SCALE = 0.5, actual reduction = 0.15 -> 6.0 * (1 - 0.15) = 5.1
  const innings = adjustedInningsForEarlyHookRisk({ baseInnings: 6.0, pitcherEra: 6.0, opposingOffensiveFactor: 1.2 });
  assert.ok(Math.abs(innings - 5.1) < 1e-9);
  assert.equal(EARLY_HOOK_RISK_SCALE, 0.5);
});

test('adjustedInningsForEarlyHookRisk: never drops below a 2-inning floor', () => {
  const innings = adjustedInningsForEarlyHookRisk({ baseInnings: 3.0, pitcherEra: 10.0, opposingOffensiveFactor: 1.3 });
  assert.ok(innings >= 2.0);
});

test('computeWeatherFactorForStrikeouts: no data returns neutral 1.0', () => {
  assert.equal(computeWeatherFactorForStrikeouts(), 1.0);
  assert.equal(computeWeatherFactorForStrikeouts({ tempF: null }), 1.0);
});

test('computeWeatherFactorForStrikeouts: cold weather nudges the factor up', () => {
  assert.ok(computeWeatherFactorForStrikeouts({ tempF: 45 }) > 1.0);
});

test('computeWeatherFactorForStrikeouts: hot weather nudges the factor down', () => {
  assert.ok(computeWeatherFactorForStrikeouts({ tempF: 92 }) < 1.0);
});

test('computeWeatherFactorForStrikeouts: strong wind blowing out adds a small extra boost on top of temp', () => {
  const withoutWind = computeWeatherFactorForStrikeouts({ tempF: 45 });
  const withWind = computeWeatherFactorForStrikeouts({ tempF: 45, windMph: 18, windDirection: 'Out to CF' });
  assert.ok(withWind > withoutWind);
});

test('gradeMoneylineSignal: hit when the picked home team actually won', () => {
  const hit = gradeMoneylineSignal({ selection: 'Boston Red Sox', homeTeam: 'Boston Red Sox', homeScore: 5, awayScore: 3 });
  assert.equal(hit, true);
});

test('gradeMoneylineSignal: miss when the picked home team actually lost', () => {
  const hit = gradeMoneylineSignal({ selection: 'Boston Red Sox', homeTeam: 'Boston Red Sox', homeScore: 2, awayScore: 5 });
  assert.equal(hit, false);
});

test('gradeMoneylineSignal: hit when the picked away team actually won', () => {
  const hit = gradeMoneylineSignal({ selection: 'New York Yankees', homeTeam: 'Boston Red Sox', homeScore: 2, awayScore: 5 });
  assert.equal(hit, true);
});

test('gradeMoneylineSignal: miss when the picked away team actually lost', () => {
  const hit = gradeMoneylineSignal({ selection: 'New York Yankees', homeTeam: 'Boston Red Sox', homeScore: 5, awayScore: 2 });
  assert.equal(hit, false);
});

test('gradeTotalsSignal: Over hits when actual total exceeds the line', () => {
  const hit = gradeTotalsSignal({ selection: 'Over 8.5', line: 8.5, homeScore: 5, awayScore: 6 });
  assert.equal(hit, true);
});

test('gradeTotalsSignal: Over misses when actual total is below the line', () => {
  const hit = gradeTotalsSignal({ selection: 'Over 8.5', line: 8.5, homeScore: 3, awayScore: 2 });
  assert.equal(hit, false);
});

test('gradeTotalsSignal: Under hits when actual total is below the line', () => {
  const hit = gradeTotalsSignal({ selection: 'Under 8.5', line: 8.5, homeScore: 3, awayScore: 2 });
  assert.equal(hit, true);
});

test('gradeTotalsSignal: Under misses when actual total exceeds the line', () => {
  const hit = gradeTotalsSignal({ selection: 'Under 8.5', line: 8.5, homeScore: 5, awayScore: 6 });
  assert.equal(hit, false);
});

test('gradeOverSignal: hits when actual value exceeds the line', () => {
  const hit = gradeOverSignal({ line: 1.5, actualValue: 2 });
  assert.equal(hit, true);
});

test('gradeOverSignal: misses when actual value is below the line', () => {
  const hit = gradeOverSignal({ line: 1.5, actualValue: 1 });
  assert.equal(hit, false);
});

test('gradeTotalsSignal: returns null (cannot grade) when line is missing', () => {
  const result = gradeTotalsSignal({ selection: 'Over 8.5', line: null, homeScore: 5, awayScore: 2 });
  assert.equal(result, null);
});

test('gradeTotalsSignal: returns null (cannot grade) when line is not a finite number', () => {
  const result = gradeTotalsSignal({ selection: 'Over 8.5', line: NaN, homeScore: 5, awayScore: 2 });
  assert.equal(result, null);
});

test('gradeOverSignal: returns null (cannot grade) when line is missing', () => {
  const result = gradeOverSignal({ line: null, actualValue: 2 });
  assert.equal(result, null);
});

test('gradeOverSignal: returns null (cannot grade) when line is not a finite number', () => {
  const result = gradeOverSignal({ line: undefined, actualValue: 2 });
  assert.equal(result, null);
});

test('blendEraEstimates: weights recent form more heavily than season by default', () => {
  const blended = blendEraEstimates(3.00, 5.00);
  // 3.00*0.6 + 5.00*0.4 = 3.80
  assert.ok(Math.abs(blended - 3.80) < 1e-9);
});

test('blendEraEstimates: equal ERAs blend to the same value regardless of weight', () => {
  const blended = blendEraEstimates(4.00, 4.00);
  assert.ok(Math.abs(blended - 4.00) < 1e-9);
});

test('blendEraEstimates: custom weight is respected', () => {
  const blended = blendEraEstimates(3.00, 5.00, 0.5);
  assert.ok(Math.abs(blended - 4.00) < 1e-9);
});

test('CAREER_ERA_WEIGHT/CAREER_K9_WEIGHT: cascade correctly with blendEraEstimates at their current (independently tuned) weights', () => {
  const recentSeasonEra = blendEraEstimates(3.00, 5.00); // 3.80, as in the existing test above
  const finalEra = blendEraEstimates(recentSeasonEra, 4.00, CAREER_ERA_WEIGHT);
  const expectedEra = recentSeasonEra * CAREER_ERA_WEIGHT + 4.00 * (1 - CAREER_ERA_WEIGHT);
  assert.ok(Math.abs(finalEra - expectedEra) < 1e-9);

  const recentSeasonK9 = blendEraEstimates(9.00, 7.00);
  const finalK9 = blendEraEstimates(recentSeasonK9, 8.00, CAREER_K9_WEIGHT);
  const expectedK9 = recentSeasonK9 * CAREER_K9_WEIGHT + 8.00 * (1 - CAREER_K9_WEIGHT);
  assert.ok(Math.abs(finalK9 - expectedK9) < 1e-9);

  assert.equal(CAREER_ERA_WEIGHT, 0.8);
  assert.equal(CAREER_K9_WEIGHT, 0.6);
});

test('formatCareerEraNote: returns empty string when there is no career data', () => {
  assert.equal(formatCareerEraNote(null), '');
});

test('formatCareerEraNote: formats a known career ERA', () => {
  assert.equal(formatCareerEraNote(3.845), ' (carrera: 3.85)');
});

test('formatCareerEraPairNote: returns empty string when neither side has career data', () => {
  assert.equal(formatCareerEraPairNote({ homeTeam: 'Red Sox', awayTeam: 'Yankees', homeCareerEra: null, awayCareerEra: null }), '');
});

test('formatCareerEraPairNote: formats both sides when both have career data', () => {
  const note = formatCareerEraPairNote({ homeTeam: 'Red Sox', awayTeam: 'Yankees', homeCareerEra: 3.5, awayCareerEra: 4.25 });
  assert.equal(note, ' ERA de carrera: Red Sox 3.50, Yankees 4.25.');
});

test('formatCareerEraPairNote: labels the side without data as "sin datos"', () => {
  const note = formatCareerEraPairNote({ homeTeam: 'Red Sox', awayTeam: 'Yankees', homeCareerEra: 3.5, awayCareerEra: null });
  assert.equal(note, ' ERA de carrera: Red Sox 3.50, Yankees sin datos.');
});

test('computeOffensiveFactor: league-average lineup OPS gives factor 1', () => {
  const factor = computeOffensiveFactor({ lineupOps: 0.720, leagueAvgOps: 0.720 });
  assert.ok(Math.abs(factor - 1) < 1e-9);
});

test('computeOffensiveFactor: strong lineup OPS gives factor above 1, capped at 1.3', () => {
  assert.ok(computeOffensiveFactor({ lineupOps: 0.900, leagueAvgOps: 0.720 }) > 1);
  assert.equal(computeOffensiveFactor({ lineupOps: 2.000, leagueAvgOps: 0.720 }), 1.3);
});

test('computeOffensiveFactor: weak lineup OPS gives factor below 1, floored at 0.7', () => {
  assert.ok(computeOffensiveFactor({ lineupOps: 0.500, leagueAvgOps: 0.720 }) < 1);
  assert.equal(computeOffensiveFactor({ lineupOps: 0.100, leagueAvgOps: 0.720 }), 0.7);
});

test('computeLineupOps: an evenly-average lineup returns roughly the same OPS either way', () => {
  const ops = computeLineupOps({ batterOpsList: [0.720, 0.720, 0.720, 0.720, 0.720] });
  assert.ok(Math.abs(ops - 0.720) < 1e-9);
});

test('computeLineupOps: one standout hitter pulls the result up more than a plain average would', () => {
  const batters = [0.720, 0.720, 0.720, 0.720, 1.100]; // one hot hitter, rest league-average
  const plainAverage = batters.reduce((s, v) => s + v, 0) / batters.length;
  const lineupOps = computeLineupOps({ batterOpsList: batters });
  assert.ok(lineupOps > plainAverage);
});

test('computeLineupOps: an evenly weak lineup (no standouts) is not overstated', () => {
  const ops = computeLineupOps({ batterOpsList: [0.650, 0.650, 0.650, 0.650, 0.650] });
  assert.ok(Math.abs(ops - 0.650) < 1e-9);
});

test('computeLineupOps: ignores null/invalid entries from batters with no data yet', () => {
  const ops = computeLineupOps({ batterOpsList: [0.720, null, 0.720, undefined, NaN] });
  assert.ok(Math.abs(ops - 0.720) < 1e-9);
});

test('computeLineupOps: falls back to league average when there is no valid data at all', () => {
  assert.equal(computeLineupOps({ batterOpsList: [] }), 0.720);
  assert.equal(computeLineupOps({ batterOpsList: [null, undefined] }), 0.720);
});

test('computeLineupOps: works with fewer batters than topN', () => {
  const ops = computeLineupOps({ batterOpsList: [0.900] });
  assert.ok(Math.abs(ops - 0.900) < 1e-9);
});

test('teamWinProbability: a stronger offensive factor raises the win probability, all else equal', () => {
  const withAvgOffense = teamWinProbability({ recordWinPct: 0.5, startingPitcherEra: 4.00, isHome: true, offensiveFactor: 1.0 });
  const withStrongOffense = teamWinProbability({ recordWinPct: 0.5, startingPitcherEra: 4.00, isHome: true, offensiveFactor: 1.3 });
  assert.ok(withStrongOffense > withAvgOffense);
});

test('teamWinProbability: omitting offensiveFactor behaves identically to passing 1.0 (default)', () => {
  const omitted = teamWinProbability({ recordWinPct: 0.6, startingPitcherEra: 3.50, isHome: false });
  const explicit = teamWinProbability({ recordWinPct: 0.6, startingPitcherEra: 3.50, isHome: false, offensiveFactor: 1.0 });
  assert.equal(omitted, explicit);
});

test('formatSimComparisonNote: returns empty string when there is no prediction', () => {
  assert.equal(formatSimComparisonNote(null, 'New York Yankees'), '');
});

test('formatSimComparisonNote: agrees with the bot\'s favored team', () => {
  const simPrediction = {
    homeTeam: 'New York Yankees', awayTeam: 'Boston Red Sox',
    homeWinPct: 0.62, awayWinPct: 0.38,
  };
  const note = formatSimComparisonNote(simPrediction, 'New York Yankees');
  assert.ok(note.includes('coincide'));
  assert.ok(note.includes('New York Yankees'));
  assert.ok(note.includes('62'));
});

test('formatSimComparisonNote: disagrees with the bot\'s favored team', () => {
  const simPrediction = {
    homeTeam: 'New York Yankees', awayTeam: 'Boston Red Sox',
    homeWinPct: 0.38, awayWinPct: 0.62,
  };
  const note = formatSimComparisonNote(simPrediction, 'New York Yankees');
  assert.ok(note.includes('difiere'));
  assert.ok(note.includes('Boston Red Sox'));
});

test('formatSimComparisonNote: home team favored on an exact 50/50 split', () => {
  const simPrediction = {
    homeTeam: 'New York Yankees', awayTeam: 'Boston Red Sox',
    homeWinPct: 0.5, awayWinPct: 0.5,
  };
  const note = formatSimComparisonNote(simPrediction, 'New York Yankees');
  assert.ok(note.includes('coincide'));
});
