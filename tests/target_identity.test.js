/**
 * Offline safety tests for CDP target identity and new-object binding.
 *
 * These run without TradingView. That is the point: the properties under test are
 * decision rules, and a rule that can only be checked against a live desktop app
 * is a rule nobody checks. The fixture below is a real capture from a German-locale
 * TradingView Desktop build, which is where the original defect was found.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';

import {
  classifyTarget,
  selectNewTarget,
  describeSelectionFailure,
  toProtectedIdSet,
  protectedIdsFromEnv,
  SELECT_NO_CANDIDATE,
  SELECT_AMBIGUOUS,
  SELECT_PROTECTED_ONLY,
  LEGACY_LANDING_TITLE,
} from '../src/core/target_identity.js';

const ASAR = 'file:///Applications/TradingView.app/Contents/Resources/app.asar/app';

/** The protected production chart in the capture. */
const FORWARD_ID = '4181660187938F798518018A9B50833D';

const page = (id, url, title = '') => ({ id, type: 'page', url, title });

/** Verbatim shape of the live German-locale /json/list capture. */
const LIVE_CAPTURE = [
  page('4AA544FF19978B0978776D69EFE664D8', `${ASAR}/new-tab/index.html?rendererInit`, 'Neuer Tab'),
  page('FEC3150349CABE0ECF78F2D2703371FC', `${ASAR}/new-tab/index.html?rendererInit`, 'Neuer Tab'),
  page('8CF63AAAD992B3AD60131D1944FD533F', `${ASAR}/new-tab/index.html?rendererInit`, 'Neuer Tab'),
  page(FORWARD_ID, 'https://de.tradingview.com/chart/46KLOrNp/', 'Aktien, Indizes, Futures'),
  page('88864B99C12364D9', `${ASAR}/window/index.html?rendererInit`, 'index.html'),
  page('1EDD427A6A05E861FD98286818162442', `${ASAR}/new-tab/index.html?rendererInit`, 'Neuer Tab'),
  page('40F720BD1366C162', `${ASAR}/tooltip/index.html?rendererInit`, 'index.html'),
  { id: '321249473218B889', type: 'worker', url: '', title: '' },
];

describe('classifyTarget — structural identity, not presentation', () => {
  it('recognizes a localized landing page the old title check could not see', () => {
    const german = page('A1', `${ASAR}/new-tab/index.html`, 'Neuer Tab');
    assert.equal(classifyTarget(german), 'landing');
    // The precise historical defect: this title is not 'New tab'.
    assert.notEqual(german.title, LEGACY_LANDING_TITLE);
  });

  it('still honours the exact English title as a last-resort hint (requirement 1)', () => {
    // No recognizable URL at all, only the legacy title.
    assert.equal(classifyTarget(page('A2', 'about:blank', 'New tab')), 'landing');
  });

  it('excludes the Electron shell window that owns the tab bar (requirement 5)', () => {
    assert.equal(classifyTarget(page('A3', `${ASAR}/window/index.html`, 'index.html')), 'shell');
  });

  it('never reclassifies a chart as a landing page, even if titled "New tab" (requirement 7)', () => {
    const trap = page('A4', 'https://de.tradingview.com/chart/46KLOrNp/', 'New tab');
    assert.equal(classifyTarget(trap), 'chart');
  });

  it('never reclassifies the shell as a landing page, even if titled "New tab"', () => {
    assert.equal(classifyTarget(page('A5', `${ASAR}/window/index.html`, 'New tab')), 'shell');
  });

  it('treats non-page targets as other', () => {
    assert.equal(classifyTarget({ id: 'W', type: 'worker', url: '', title: 'New tab' }), 'other');
    assert.equal(classifyTarget(null), 'other');
    assert.equal(classifyTarget({ id: 'X', type: 'page' }), 'other');
  });

  it('classifies the whole live capture as 4 landing, 1 chart, 1 shell', () => {
    const kinds = LIVE_CAPTURE.map(classifyTarget);
    assert.equal(kinds.filter(k => k === 'landing').length, 4);
    assert.equal(kinds.filter(k => k === 'chart').length, 1);
    assert.equal(kinds.filter(k => k === 'shell').length, 1);
  });
});

describe('selectNewTarget — set-delta identity with uniqueness', () => {
  it('binds a landing page proven new by set difference despite a changed title (requirement 2)', () => {
    const before = [LIVE_CAPTURE[3], LIVE_CAPTURE[4]];
    const after = [...before, page('NEW1', `${ASAR}/new-tab/index.html`, 'Neuer Tab')];
    const r = selectNewTarget({ before, after, kind: 'landing', protectedIds: [FORWARD_ID] });
    assert.ok(r.ok);
    assert.equal(r.target.id, 'NEW1');
  });

  it('fails closed when nothing new appeared (requirement 3)', () => {
    const r = selectNewTarget({
      before: LIVE_CAPTURE, after: LIVE_CAPTURE, kind: 'landing', protectedIds: [FORWARD_ID],
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, SELECT_NO_CANDIDATE);
  });

  it('fails closed on two ambiguous new candidates rather than guessing (requirement 4)', () => {
    const before = [LIVE_CAPTURE[4]];
    const after = [
      ...before,
      page('N1', `${ASAR}/new-tab/index.html`, 'Neuer Tab'),
      page('N2', `${ASAR}/new-tab/index.html`, 'Neuer Tab'),
    ];
    const r = selectNewTarget({ before, after, kind: 'landing' });
    assert.equal(r.ok, false);
    assert.equal(r.reason, SELECT_AMBIGUOUS);
    assert.deepEqual(r.candidateIds.sort(), ['N1', 'N2']);
  });

  it('ignores the four PRE-EXISTING landing tabs in the live capture', () => {
    // Everything already present, so a create action that produced nothing must
    // not silently adopt one of the four strays.
    const r = selectNewTarget({
      before: LIVE_CAPTURE, after: LIVE_CAPTURE, kind: 'landing',
    });
    assert.equal(r.ok, false);
  });

  it('never selects a protected target, even when it is the only match (requirement 6)', () => {
    const before = [];
    const after = [LIVE_CAPTURE[3]]; // the Forward chart, "new" relative to an empty snapshot
    const r = selectNewTarget({ before, after, kind: 'chart', protectedIds: [FORWARD_ID] });
    assert.equal(r.ok, false);
    assert.equal(r.reason, SELECT_PROTECTED_ONLY);
    assert.deepEqual(r.candidateIds, [FORWARD_ID]);
  });

  it('distinguishes "protected only" from "nothing appeared" in its diagnostics', () => {
    const blocked = selectNewTarget({
      before: [], after: [LIVE_CAPTURE[3]], kind: 'chart', protectedIds: [FORWARD_ID],
    });
    const empty = selectNewTarget({ before: [], after: [], kind: 'chart' });
    assert.notEqual(blocked.reason, empty.reason);
    assert.match(describeSelectionFailure('chart', blocked), /protected/i);
    assert.match(describeSelectionFailure('chart', empty), /No new chart target/i);
  });

  it('does not mistake a pre-existing chart for a newly created one (requirement 7)', () => {
    const before = [LIVE_CAPTURE[3]];
    const after = [LIVE_CAPTURE[3]];
    const r = selectNewTarget({ before, after, kind: 'chart' });
    assert.equal(r.ok, false);
    assert.equal(r.reason, SELECT_NO_CANDIDATE);
  });

  it('follows the renderer swap to a brand-new chart target id (requirement 8)', () => {
    const landing = page('L1', `${ASAR}/new-tab/index.html`, 'Neuer Tab');
    const before = [LIVE_CAPTURE[3], landing];
    // Landing target disappears, a new chart target appears under a different id.
    const after = [LIVE_CAPTURE[3], page('C9', 'https://de.tradingview.com/chart/ZZZ/', 'chart')];
    const r = selectNewTarget({
      before, after, kind: 'chart', protectedIds: [FORWARD_ID], alsoAllowIds: [landing.id],
    });
    assert.ok(r.ok);
    assert.equal(r.target.id, 'C9');
  });

  it('follows an in-place navigation where the landing target keeps its id (requirement 8)', () => {
    const landing = page('L2', `${ASAR}/new-tab/index.html`, 'Neuer Tab');
    const before = [LIVE_CAPTURE[3], landing];
    const after = [
      LIVE_CAPTURE[3],
      page('L2', 'https://de.tradingview.com/chart/YYY/', 'chart'), // same id, now a chart
    ];
    const r = selectNewTarget({
      before, after, kind: 'chart', protectedIds: [FORWARD_ID], alsoAllowIds: ['L2'],
    });
    assert.ok(r.ok);
    assert.equal(r.target.id, 'L2');
  });

  it('the in-place allowance does not open a hole for the protected chart', () => {
    // Even if the Forward id were wrongly passed as "ours", protection wins.
    const r = selectNewTarget({
      before: [LIVE_CAPTURE[3]], after: [LIVE_CAPTURE[3]], kind: 'chart',
      protectedIds: [FORWARD_ID], alsoAllowIds: [FORWARD_ID],
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, SELECT_PROTECTED_ONLY);
  });

  it('fails closed when the post-pick chart target is ambiguous (requirement 9)', () => {
    const before = [LIVE_CAPTURE[4]];
    const after = [
      ...before,
      page('C1', 'https://de.tradingview.com/chart/AAA/', 'chart'),
      page('C2', 'https://de.tradingview.com/chart/BBB/', 'chart'),
    ];
    const r = selectNewTarget({ before, after, kind: 'chart' });
    assert.equal(r.ok, false);
    assert.equal(r.reason, SELECT_AMBIGUOUS);
  });

  it('excludes shell and worker targets from every selection (requirement 5)', () => {
    const before = [];
    const after = [
      page('S1', `${ASAR}/window/index.html`, 'index.html'),
      { id: 'W1', type: 'worker', url: '', title: '' },
    ];
    assert.equal(selectNewTarget({ before, after, kind: 'landing' }).ok, false);
    assert.equal(selectNewTarget({ before, after, kind: 'chart' }).ok, false);
  });
});

describe('protected-id plumbing', () => {
  it('parses comma and whitespace separated deny lists', () => {
    assert.deepEqual([...toProtectedIdSet('A, B  C')].sort(), ['A', 'B', 'C']);
    assert.deepEqual([...toProtectedIdSet(['A', 'B'])].sort(), ['A', 'B']);
    assert.deepEqual([...toProtectedIdSet(new Set(['A']))], ['A']);
    assert.equal(toProtectedIdSet(null).size, 0);
    assert.equal(toProtectedIdSet('').size, 0);
  });

  it('reads TV_PROTECTED_TARGET_IDS from the environment', () => {
    assert.ok(protectedIdsFromEnv({ TV_PROTECTED_TARGET_IDS: FORWARD_ID }).has(FORWARD_ID));
    assert.equal(protectedIdsFromEnv({}).size, 0);
  });
});

describe('tab.js wiring', () => {
  const src = readFileSync(new URL('../src/core/tab.js', import.meta.url), 'utf8');

  it('no longer decides landing identity from a localized title (requirement 11)', () => {
    // The only surviving mention is prose in a comment explaining the defect.
    const code = src.split('\n').filter(l => !/^\s*(\*|\/\/)/.test(l)).join('\n');
    assert.ok(!code.includes("'New tab'"), 'tab.js still branches on the English title');
  });

  it('lists tabs by structural classification', () => {
    assert.match(src, /classifyTarget\(t\) === 'chart'/);
    assert.match(src, /kind === 'chart' \|\| kind === 'landing'/);
  });

  it('proves a target before every reconnect in the create path (requirement 10)', () => {
    const newTab = src.slice(src.indexOf('export async function newTab'), src.indexOf('export async function closeTab'));
    const proofAt = newTab.indexOf('selectNewTarget');
    const denyAt = newTab.indexOf('deny.has(chartTarget.id)');
    const reconnectAt = newTab.indexOf('reconnectTo(');
    assert.ok(proofAt !== -1 && denyAt !== -1 && reconnectAt !== -1);
    assert.ok(proofAt < reconnectAt, 'selection must precede reconnect');
    assert.ok(denyAt < reconnectAt, 'protected-target check must precede reconnect');
  });

  it('keeps the currently attached target on the deny list', () => {
    assert.match(src, /async function protectedTargetIds/);
    // Must resolve the attached target through connection.js's accessor. A CDP
    // client object does not expose it, so `client.target.id` silently yields
    // undefined -- which would quietly empty the deny list of the one target that
    // matters most, the chart we are already attached to.
    assert.match(src, /await getTargetInfo\(\)/);
    assert.match(src, /ids\.add\(current\.id\)/);
    assert.ok(!src.includes('client?.target?.id'), 'uses an accessor that is always undefined here');
    assert.match(src, /import \{[^}]*getTargetInfo[^}]*\} from '\.\.\/connection\.js'/);
  });

  it('computes the deny list once, before the create action, and reuses it', () => {
    const newTab = src.slice(src.indexOf('export async function newTab'), src.indexOf('export async function closeTab'));
    const denyAt = newTab.indexOf('const deny = await protectedTargetIds()');
    assert.ok(denyAt !== -1, 'deny list is not computed in newTab');
    // Both selections must be fenced by the SAME deny set.
    const uses = [...newTab.matchAll(/protectedIds: deny/g)];
    assert.equal(uses.length, 2, 'both landing and chart selection must pass the deny set');
    assert.ok(uses.every(m => m.index > denyAt), 'deny set must be computed first');
  });
});
