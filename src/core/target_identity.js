/**
 * CDP target identity and classification.
 *
 * Why this module exists: tab creation used to recognize a new-tab landing page
 * only by `title === 'New tab'`. That is a presentation string, and on a
 * non-English TradingView Desktop build it is localized — a German build reports
 * `'Neuer Tab'`. The landing target was present and reachable the whole time; the
 * classifier simply could not see it, so `newTab()` created shell tabs it could
 * not bind and the MCP stayed attached to whatever chart it already held. If that
 * chart is a protected production surface, the caller is stuck.
 *
 * The identity signals used here are structural instead:
 *
 *   landing  file://…/app.asar/app/new-tab/index.html
 *   shell    file://…/app.asar/app/window/index.html
 *   chart    https://<locale>.tradingview.com/chart/<id>/
 *
 * These are Electron resource paths and a URL route, not user-visible text.
 *
 * The selection rules are deliberately pure functions over target lists so the
 * safety properties (set-delta identity, uniqueness, protected-object exclusion,
 * fail-closed on zero or multiple candidates) can be tested entirely offline,
 * without a running TradingView.
 */

export const LANDING_URL_RE = /\/app\/new-tab\/index\.html/i;
export const SHELL_URL_RE = /\/app\/window\/index\.html/i;
export const CHART_URL_RE = /tradingview\.com\/chart/i;

/**
 * The pre-localization landing title. Kept as a last-resort hint so builds that
 * expose no recognizable landing URL still work, never as proof on its own: it is
 * consulted only after the structural URL checks have all failed, so it can never
 * reclassify a chart or shell target.
 */
export const LEGACY_LANDING_TITLE = 'New tab';

/** Fail-closed reasons. Machine-readable so callers can branch and report. */
export const SELECT_NO_CANDIDATE = 'NO_NEW_TARGET';
export const SELECT_AMBIGUOUS = 'AMBIGUOUS_NEW_TARGETS';
export const SELECT_PROTECTED_ONLY = 'ONLY_PROTECTED_TARGET_MATCHED';

/**
 * Classify one CDP target as 'chart' | 'landing' | 'shell' | 'other'.
 *
 * Non-page targets (workers, service workers) are always 'other'.
 */
export function classifyTarget(target) {
  if (!target || target.type !== 'page') return 'other';
  const url = typeof target.url === 'string' ? target.url : '';

  // Structural checks first. Chart and shell are decided before the title hint is
  // ever consulted, so a chart tab that happens to be titled 'New tab' cannot be
  // mistaken for a landing page.
  if (CHART_URL_RE.test(url)) return 'chart';
  if (SHELL_URL_RE.test(url)) return 'shell';
  if (LANDING_URL_RE.test(url)) return 'landing';

  if (target.title === LEGACY_LANDING_TITLE) return 'landing';
  return 'other';
}

/** DOM markers that identify the layout picker, independent of language. */
export const LANDING_DOM_PROBE = `(function() {
  return !!(document.querySelector('.create-new-layout-button')
         || document.querySelector('.layout-list-item')
         || document.querySelector('.layout-list-expand-button'));
})()`;

/** Normalize a protected-id input (string, array, Set, env list) to a Set. */
export function toProtectedIdSet(input) {
  if (!input) return new Set();
  if (input instanceof Set) return new Set(input);
  const list = Array.isArray(input) ? input : String(input).split(/[,\s]+/);
  return new Set(list.map(s => String(s).trim()).filter(Boolean));
}

/**
 * Protected target ids that may never be selected as a newly created object.
 *
 * Seeded from TV_PROTECTED_TARGET_IDS (comma or whitespace separated) so an
 * operator can fence off a production chart without code changes.
 */
export function protectedIdsFromEnv(env = process.env) {
  return toProtectedIdSet(env.TV_PROTECTED_TARGET_IDS);
}

/**
 * Choose the one target of `kind` that appeared between two snapshots.
 *
 * Identity comes from the target-ID set difference, never from order, title or
 * position. `alsoAllowIds` admits targets that were already present but whose
 * ownership is independently proven — the landing page we created navigating in
 * place to a chart, which keeps its target id on some builds.
 *
 * Returns `{ ok: true, target }`, or `{ ok: false, reason, candidateIds }`.
 * Zero candidates and several candidates are both failures: there is no
 * "probably ours" branch, because guessing here is what hands a caller authority
 * over an object it did not create.
 */
export function selectNewTarget({
  before = [],
  after = [],
  kind,
  protectedIds,
  alsoAllowIds = [],
} = {}) {
  const beforeIds = new Set(before.map(t => t.id));
  const protectedSet = toProtectedIdSet(protectedIds);
  const allowed = toProtectedIdSet(alsoAllowIds);

  const matching = after.filter(t => classifyTarget(t) === kind);
  const fresh = matching.filter(t => !beforeIds.has(t.id) || allowed.has(t.id));

  // The protected object is excluded unconditionally, and we distinguish "nothing
  // appeared" from "the only thing that matched was the one object we must not
  // touch" — the second is a far more alarming diagnostic.
  const admissible = fresh.filter(t => !protectedSet.has(t.id));
  if (admissible.length === 1) return { ok: true, target: admissible[0] };

  if (admissible.length === 0) {
    const blocked = fresh.some(t => protectedSet.has(t.id));
    return {
      ok: false,
      reason: blocked ? SELECT_PROTECTED_ONLY : SELECT_NO_CANDIDATE,
      candidateIds: fresh.map(t => t.id),
    };
  }
  return {
    ok: false,
    reason: SELECT_AMBIGUOUS,
    candidateIds: admissible.map(t => t.id),
  };
}

/** Human-readable failure text for a selectNewTarget result. */
export function describeSelectionFailure(kind, result) {
  const ids = (result.candidateIds || []).join(', ') || 'none';
  switch (result.reason) {
    case SELECT_NO_CANDIDATE:
      return `No new ${kind} target appeared; refusing to bind an existing one.`;
    case SELECT_AMBIGUOUS:
      return `Ambiguous new ${kind} targets (${ids}); refusing to guess which is ours.`;
    case SELECT_PROTECTED_ONLY:
      return `The only matching ${kind} target is protected (${ids}); refusing to bind it.`;
    default:
      return `Could not identify a new ${kind} target (${result.reason}).`;
  }
}
