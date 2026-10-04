/**
 * Core tab management logic.
 *
 * TradingView Desktop's tab bar lives in a separate Electron shell window
 * (app/window/index.html), not in the chart pages themselves. CDP-level
 * activation (/json/activate) and synthesized Ctrl+T/Ctrl+W key events do
 * not drive it (Electron accelerators don't fire from CDP input), so tab
 * switching/creation/closing click the shell window's DOM directly:
 * `.tabs-container .tab`, its close button, and `create-new-tab-button`.
 * (Approach from issue #155 and PR #163, verified on Desktop 3.1.0.)
 */
import CDP from 'chrome-remote-interface';
import { getClient, getTargetInfo, reconnectTo, CDP_HOST, CDP_PORT } from '../connection.js';
import {
  classifyTarget,
  selectNewTarget,
  describeSelectionFailure,
  protectedIdsFromEnv,
  toProtectedIdSet,
  LANDING_DOM_PROBE,
} from './target_identity.js';

/**
 * List all open chart tabs (CDP page targets).
 */
export async function list() {
  const resp = await fetch(`http://${CDP_HOST}:${CDP_PORT}/json/list`);
  const targets = await resp.json();

  // Chart tabs plus new-tab landing pages (layout picker), so every tab in the
  // top bar is listable and switchable.
  const tabs = targets
    .filter(t => {
      const kind = classifyTarget(t);
      return kind === 'chart' || kind === 'landing';
    })
    .map((t, i) => ({
      index: i,
      id: t.id,
      title: t.title.replace(/^Live stock.*charts on /, ''),
      url: t.url,
      chart_id: t.url.match(/\/chart\/([^/?]+)/)?.[1] || null,
      is_chart: classifyTarget(t) === 'chart',
    }));

  return { success: true, tab_count: tabs.length, tabs };
}

/**
 * Run fn with a CDP client attached to the Electron shell window that owns
 * the tab bar. There can be several app/window/index.html targets; the shell
 * is the one whose DOM actually contains `.tabs-container .tab`.
 */
async function withShell(fn) {
  const resp = await fetch(`http://${CDP_HOST}:${CDP_PORT}/json/list`);
  const targets = await resp.json();
  const candidates = targets.filter(t => t.type === 'page' && /\/window\/index\.html/i.test(t.url || ''));

  for (const cand of candidates) {
    let c = null;
    try {
      c = await CDP({ host: CDP_HOST, port: CDP_PORT, target: cand.id });
      const probe = await c.Runtime.evaluate({
        expression: `!!document.querySelector('.tabs-container .tab')`,
        returnByValue: true,
      });
      if (probe.result?.value) {
        const out = await fn(async (expression) => {
          const { result } = await c.Runtime.evaluate({ expression, returnByValue: true });
          return result?.value;
        });
        await c.close();
        return out;
      }
      await c.close();
    } catch {
      try { if (c) await c.close(); } catch { /* already gone */ }
    }
  }
  throw new Error('TradingView shell window (tab bar) not found. Is this TradingView Desktop with tabs?');
}

/** Check whether a CDP page target is the visible one. */
async function isTargetVisible(targetId) {
  let c = null;
  try {
    c = await CDP({ host: CDP_HOST, port: CDP_PORT, target: targetId });
    const { result } = await c.Runtime.evaluate({ expression: 'document.visibilityState', returnByValue: true });
    return result?.value === 'visible';
  } catch {
    return false;
  } finally {
    try { if (c) await c.close(); } catch { /* already gone */ }
  }
}

/** Fetch the full CDP target list. */
async function listTargets() {
  const resp = await fetch(`http://${CDP_HOST}:${CDP_PORT}/json/list`);
  return resp.json();
}

/**
 * The targets we must never hand back as "newly created": anything the operator
 * fenced off via TV_PROTECTED_TARGET_IDS, plus whatever this client is currently
 * attached to. The second half matters because the chart we already hold is, by
 * definition, not the one a create action just produced.
 */
async function protectedTargetIds() {
  const ids = protectedIdsFromEnv();
  try {
    const current = await getTargetInfo();
    if (current?.id) ids.add(current.id);
  } catch {
    // Not attached yet; the env deny-list still applies.
  }
  return ids;
}

/**
 * Find an open new-tab landing page target (the layout picker).
 *
 * Identified structurally, so it works on localized builds where the tab title is
 * not the English 'New tab'. Protected targets are never returned.
 */
async function findLandingTarget(protectedIds = null) {
  const targets = await listTargets();
  const deny = protectedIds ? toProtectedIdSet(protectedIds) : await protectedTargetIds();
  return targets.find(t => classifyTarget(t) === 'landing' && !deny.has(t.id)) || null;
}

/** Read-only probe: does this target's DOM actually show the layout picker? */
async function hasLandingDom(targetId) {
  try {
    return await withTarget(targetId, async (evalIn) => !!(await evalIn(LANDING_DOM_PROBE)));
  } catch {
    return false;
  }
}

/** Run fn with an eval helper attached to a specific target. */
async function withTarget(targetId, fn) {
  let c = null;
  try {
    c = await CDP({ host: CDP_HOST, port: CDP_PORT, target: targetId });
    return await fn(async (expression) => {
      const { result } = await c.Runtime.evaluate({ expression, returnByValue: true });
      return result?.value;
    });
  } finally {
    try { if (c) await c.close(); } catch { /* already gone */ }
  }
}

/**
 * Open a new chart tab by clicking the shell window's new-tab button.
 * With `layout`, also picks from the landing page's layout list:
 *   layout: 'new'    -> click "Create new layout" (blank chart, saved as Unnamed)
 *   layout: '<name>' -> open the saved layout whose title contains <name>
 * Reuses an already-open landing tab instead of opening another one.
 */
export async function newTab({ layout, name } = {}) {
  const deny = await protectedTargetIds();
  let landing = await findLandingTarget(deny);
  let shellCounts = null;

  if (!landing) {
    // Snapshot the full target set BEFORE the side effect, so the object the click
    // creates can be identified by set difference rather than by its title.
    const targetsBefore = await listTargets();

    shellCounts = await withShell(async (evalIn) => {
      const before = await evalIn(`document.querySelectorAll('.tabs-container .tab').length`);
      const clicked = await evalIn(`
        (function() {
          var btn = document.querySelector('[class*="create-new-tab"]');
          if (!btn) return false;
          btn.click();
          return true;
        })()
      `);
      if (!clicked) throw new Error('New-tab button not found in shell window.');
      await new Promise(r => setTimeout(r, 1500));
      const after = await evalIn(`document.querySelectorAll('.tabs-container .tab').length`);
      return { before, after };
    });

    // Poll for the new landing target, then require that exactly one appeared and
    // that its DOM really is the layout picker. Zero or several -> fail closed.
    let selection = null;
    for (let i = 0; i < 20; i++) {
      const targetsAfter = await listTargets();
      selection = selectNewTarget({
        before: targetsBefore,
        after: targetsAfter,
        kind: 'landing',
        protectedIds: deny,
      });
      if (selection.ok && await hasLandingDom(selection.target.id)) break;
      if (selection.ok) selection = { ok: false, reason: 'LANDING_DOM_NOT_CONFIRMED', candidateIds: [selection.target.id] };
      await new Promise(r => setTimeout(r, 500));
    }
    if (!selection || !selection.ok) {
      throw new Error(
        `${describeSelectionFailure('landing', selection || { reason: 'NO_NEW_TARGET' })} `
        + 'The shell may have opened a tab that could not be bound; no further action was taken.'
      );
    }
    landing = selection.target;
  }

  if (!layout) {
    const state = await list();
    return {
      success: shellCounts ? shellCounts.after > shellCounts.before : !!landing,
      action: 'new_tab_opened',
      note: 'Tab is on the layout picker. Call tab_new with layout: "new" or a saved layout name to open a chart in it.',
      ...state,
    };
  }

  if (!landing) throw new Error('New tab opened but its landing page target was not found.');

  // Snapshot every target so the chart the pick creates can be identified by set
  // difference. The landing -> chart navigation swaps renderer processes, so the
  // new chart usually arrives under a NEW target id; on some builds the landing
  // target navigates in place and keeps its id, which is why it is allow-listed
  // below rather than treated as pre-existing.
  const targetsBeforePick = await listTargets();

  const wantNew = String(layout).trim().toLowerCase() === 'new';
  const layoutName = name || 'New layout';
  const picked = await withTarget(landing.id, async (evalIn) => {
    if (wantNew) {
      // "Create new layout" opens a naming dialog; the Create button stays
      // disabled until the name input is filled (React controlled input, so
      // the native value setter + input event are required).
      await evalIn(`(function(){ var b = document.querySelector('.create-new-layout-button'); if (b) b.click(); })()`);
      await new Promise(r => setTimeout(r, 700));
      const filled = await evalIn(`
        (function() {
          // The dialog's name field (not the landing page's Search box).
          var inp = document.querySelector('input[placeholder="My layout"]');
          if (!inp) {
            var dlg = document.querySelector('[class*="dialog"], [role="dialog"]');
            if (dlg) inp = dlg.querySelector('input');
          }
          if (!inp) return 'no-dialog-input';
          var setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
          setter.call(inp, ${JSON.stringify(name || 'New layout')});
          inp.dispatchEvent(new Event('input', { bubbles: true }));
          return 'filled';
        })()
      `);
      if (filled !== 'filled') throw new Error(`Create-layout dialog did not open as expected (${filled}).`);
      await new Promise(r => setTimeout(r, 400));
      const created = await evalIn(`
        (function() {
          var scope = document.querySelector('[class*="dialog"], [role="dialog"]') || document;
          var btns = scope.querySelectorAll('button');
          for (var i = 0; i < btns.length; i++) {
            var t = (btns[i].textContent || '').trim().toLowerCase();
            if (t === 'create' && !btns[i].disabled) { btns[i].click(); return true; }
          }
          return false;
        })()
      `);
      if (!created) throw new Error('Create button not found or still disabled in the layout dialog.');
      return layoutName;
    }
    const clickByTitle = `
      (function() {
        var q = ${JSON.stringify(String(layout).toLowerCase())};
        var items = document.querySelectorAll('.layout-list-item');
        for (var i = 0; i < items.length; i++) {
          var t = items[i].querySelector('.layout-list-item-title');
          if (t && t.textContent.trim().toLowerCase().indexOf(q) !== -1) {
            items[i].click();
            return t.textContent.trim();
          }
        }
        return null;
      })()
    `;
    let foundTitle = await evalIn(clickByTitle);
    if (!foundTitle) {
      // Not in the recents — expand the full layout list and retry.
      await evalIn(`(function(){ var b = document.querySelector('.layout-list-expand-button'); if (b) b.click(); })()`);
      await new Promise(r => setTimeout(r, 800));
      foundTitle = await evalIn(clickByTitle);
    }
    return foundTitle;
  });

  if (!picked) throw new Error(`Layout matching "${layout}" not found in the layout list.`);

  // The chart loads under a NEW CDP target: the file:// landing -> https://
  // chart navigation swaps renderer processes, so the target id changes.
  // Wait for a chart target that wasn't there before the pick.
  let selection = null;
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 500));
    selection = selectNewTarget({
      before: targetsBeforePick,
      after: await listTargets(),
      kind: 'chart',
      protectedIds: deny,
      // Our own landing target is allowed to BE the new chart: navigating in place
      // keeps the id. Ownership is already proven -- we created and bound it.
      alsoAllowIds: [landing.id],
    });
    if (selection.ok) break;
  }
  if (!selection || !selection.ok) {
    throw new Error(
      `Picked "${picked}" but the resulting chart target could not be proven. `
      + describeSelectionFailure('chart', selection || { reason: 'NO_NEW_TARGET' })
    );
  }
  const chartTarget = selection.target;

  // Belt and braces: never rebind onto a protected surface, whatever the selector
  // concluded. If this ever fires, the selector has a hole and we stop instead.
  if (deny.has(chartTarget.id)) {
    throw new Error(`Refusing to bind protected target ${chartTarget.id}.`);
  }

  // Give the chart a moment to boot, then follow it.
  await new Promise(r => setTimeout(r, 2000));
  await reconnectTo(chartTarget.id);
  return {
    success: true,
    action: wantNew ? 'new_layout_created' : 'layout_opened_in_new_tab',
    layout: picked,
    chart_id: chartTarget.url.match(/\/chart\/([^/?]+)/)?.[1] || null,
  };
}

/**
 * Close the currently active tab by clicking its close button in the shell.
 */
export async function closeTab() {
  const before = await withShell((evalIn) => evalIn(`document.querySelectorAll('.tabs-container .tab').length`));
  if (before <= 1) {
    throw new Error('Cannot close the last tab. Use tv_launch to restart TradingView instead.');
  }

  const result = await withShell(async (evalIn) => {
    const clicked = await evalIn(`
      (function() {
        var active = document.querySelector('.tabs-container .tab.active') || document.querySelectorAll('.tabs-container .tab')[0];
        if (!active) return false;
        // The close container div has no handler — the real clickable is the button inside it.
        var close = active.querySelector('[class*="close"] button') || active.querySelector('button[class*="close"]') || active.querySelector('[class*="close"]');
        if (!close) return false;
        close.click();
        return true;
      })()
    `);
    if (!clicked) throw new Error('Close button not found on the active tab.');
    await new Promise(r => setTimeout(r, 1000));
    return evalIn(`document.querySelectorAll('.tabs-container .tab').length`);
  });

  // Our cached CDP client may have been attached to the closed tab — re-resolve.
  try { await getClient(); } catch { /* next tool call will reconnect */ }

  return { success: result < before, action: 'tab_closed', tabs_before: before, tabs_after: result };
}

/**
 * Switch to a chart tab by index (from tab_list). Clicks the corresponding
 * tab in the shell window so the switch is visible, verifies the desired
 * chart target actually became visible, then re-attaches the CDP client so
 * subsequent reads follow it.
 */
export async function switchTab({ index }) {
  const tabs = await list();
  const idx = Number(index);

  if (idx >= tabs.tab_count) {
    throw new Error(`Tab index ${idx} out of range (have ${tabs.tab_count} tabs)`);
  }

  const target = tabs.tabs[idx];

  if (!(await isTargetVisible(target.id))) {
    const clicked = await withShell(async (evalIn) => {
      const count = await evalIn(`document.querySelectorAll('.tabs-container .tab').length`);
      // Try the same ordinal first (shell order usually matches), then the rest.
      const order = [...new Set([Math.min(idx, count - 1), ...Array.from({ length: count }, (_, k) => k)])];
      for (const k of order) {
        await evalIn(`document.querySelectorAll('.tabs-container .tab')[${k}].click()`);
        await new Promise(r => setTimeout(r, 400));
        if (await isTargetVisible(target.id)) return k;
      }
      return null;
    });
    if (clicked === null) {
      throw new Error(`Clicked through all shell tabs but chart ${target.chart_id} never became visible.`);
    }
  }

  // Re-attach the cached CDP client so subsequent reads follow the switch.
  try {
    await reconnectTo(target.id);
  } catch (e) {
    throw new Error(`Tab is visible but failed to re-attach CDP to it: ${e.message}`);
  }

  return { success: true, action: 'switched', index: idx, tab_id: target.id, chart_id: target.chart_id, visually_switched: true };
}
