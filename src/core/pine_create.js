/**
 * Genuine new-Strategy creation: the decision logic, as pure functions.
 *
 * Background. Upstream `pine_new` and `pine_open` only replace the Monaco text buffer
 * and never rebind the editor, so a later save lands on whichever script was already
 * bound. Upstream issues #475 and #513 document that independently, and it is the same
 * failure that destroyed a saved script in this project (INC-20260927-001). Our fork
 * removed that false-success model; the remaining gap was that there was no way to
 * create a REAL new script identity at all.
 *
 * Upstream PR #415 (open, not merged) demonstrates TradingView's genuine
 * `Create new -> Indicator / Strategy / Library` workflow, live-validated against
 * Desktop. Its structural signals are reused here; its English label strings are not,
 * because this build is localized and the objective requires localization to fail
 * closed rather than guess.
 *
 * Type selection therefore prefers a language-neutral signal and only then falls back
 * to a table of KNOWN labels — never to position, order or a fuzzy match:
 *
 *   1. the keyboard accelerator shown in the menu item, which is locale-independent
 *      (Strategy is Cmd/Ctrl+K then Cmd/Ctrl+S; Indicator is ...+K ...+I)
 *   2. an exact aria-label match against known translations
 *   3. fail closed
 *
 * Whatever is chosen, the result is then PROVEN by the declaration the new buffer
 * contains. If it is not a `strategy(` declaration, nothing is saved.
 */

/** Declarations that prove which kind of script the editor actually created. */
export const DECLARATION = Object.freeze({
  indicator: /\bindicator\s*\(/,
  strategy: /\bstrategy\s*\(/,
  library: /\blibrary\s*\(/,
});

/**
 * Known aria-labels per type. Extend deliberately; an unknown locale must fail closed
 * rather than fall through to a guess.
 */
export const TYPE_LABELS = Object.freeze({
  indicator: ['Indicator', 'Indikator'],
  strategy: ['Strategy', 'Strategie'],
  library: ['Library', 'Bibliothek'],
});

/**
 * The accelerator letter TradingView shows for each type. Locale-independent: the
 * modifier glyph and the chord letters do not translate.
 */
export const TYPE_ACCELERATOR = Object.freeze({
  indicator: 'I',
  strategy: 'S',
  library: null,          // Library has no accelerator; it cannot be chosen this way
});

const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

/**
 * Does this menu item's text carry the K-then-<letter> chord for `type`?
 * Matches both the macOS glyph form ("⌘ K, ⌘ S") and a Ctrl form ("Ctrl+K, Ctrl+S").
 */
export function matchesAccelerator(text, type) {
  const letter = TYPE_ACCELERATOR[type];
  if (!letter) return false;
  const t = norm(text).toUpperCase();
  // require the K chord followed by the type letter, in that order
  const re = new RegExp(`K\\s*[,;]?\\s*(?:⌘|CTRL\\s*\\+?|CMD\\s*\\+?)?\\s*${letter}(?![A-Z])`);
  const kAt = t.search(/(?:⌘|CTRL\s*\+?|CMD\s*\+?)\s*K(?![A-Z])/);
  if (kAt === -1) return false;
  return re.test(t.slice(kAt));
}

/**
 * Choose the submenu item for `type` from the visible menu items.
 *
 * `items` is `[{ text, aria }]` as read from the DOM. Returns
 * `{ ok: true, index, by }` or `{ ok: false, reason, candidates }`.
 */
export function selectTypeMenuItem(items = [], type) {
  if (!DECLARATION[type]) return { ok: false, reason: 'UNSUPPORTED_TYPE' };

  const byAccel = items
    .map((it, i) => ({ i, it }))
    .filter(({ it }) => matchesAccelerator(it.text, type));
  if (byAccel.length === 1) return { ok: true, index: byAccel[0].i, by: 'ACCELERATOR' };
  if (byAccel.length > 1) {
    return { ok: false, reason: 'AMBIGUOUS_ACCELERATOR', candidates: byAccel.map(x => x.i) };
  }

  const labels = TYPE_LABELS[type].map(l => l.toLowerCase());
  const byLabel = items
    .map((it, i) => ({ i, it }))
    .filter(({ it }) => labels.includes(norm(it.aria).toLowerCase()));
  if (byLabel.length === 1) return { ok: true, index: byLabel[0].i, by: 'KNOWN_LABEL' };
  if (byLabel.length > 1) {
    return { ok: false, reason: 'AMBIGUOUS_LABEL', candidates: byLabel.map(x => x.i) };
  }

  // Deliberately no positional or fuzzy fallback.
  return {
    ok: false,
    reason: 'NO_LOCALE_NEUTRAL_MATCH',
    candidates: items.map(it => norm(it.aria) || norm(it.text)).slice(0, 12),
  };
}

/** Find the submenu parent structurally: the item that owns a popup. */
export function selectSubmenuParent(items = []) {
  const hits = items
    .map((it, i) => ({ i, it }))
    .filter(({ it }) => it.haspopup === 'menu' || it.haspopup === 'true');
  if (hits.length === 1) return { ok: true, index: hits[0].i };
  if (hits.length === 0) return { ok: false, reason: 'NO_SUBMENU_PARENT' };
  return { ok: false, reason: 'AMBIGUOUS_SUBMENU_PARENT', candidates: hits.map(h => h.i) };
}

/** The created buffer must prove its own type before anything is persisted. */
export function provesDeclaration(source, type) {
  const re = DECLARATION[type];
  if (!re) return false;
  return re.test(String(source ?? ''));
}

/**
 * The seven conditions the objective requires of a first save, evaluated together so
 * that a partial success cannot be mistaken for a success.
 */
export function firstSaveVerdict({
  serverPersistenceVerified,
  facadeExactNameMatches,
  inventoryBeforeIds = [],
  inventoryAfterIds = [],
  newId,
  sandboxId,
  forwardId,
  editorSource,
  savedSource,
} = {}) {
  const problems = [];
  const before = new Set(inventoryBeforeIds);
  const appeared = inventoryAfterIds.filter(id => !before.has(id));

  if (serverPersistenceVerified !== true) problems.push('SERVER_PERSISTENCE_NOT_VERIFIED');
  if (facadeExactNameMatches !== 1) problems.push(`FACADE_NAME_MATCH_${facadeExactNameMatches}`);
  if (appeared.length !== 1) problems.push(`INVENTORY_DELTA_${appeared.length}`);
  if (!newId) problems.push('NEW_ID_MISSING');
  if (newId && appeared.length === 1 && appeared[0] !== newId) problems.push('NEW_ID_NOT_THE_DELTA');
  if (newId && before.has(newId)) problems.push('NEW_ID_EXISTED_BEFORE');
  if (newId && sandboxId && newId === sandboxId) problems.push('NEW_ID_IS_THE_SANDBOX');
  if (newId && forwardId && newId === forwardId) problems.push('NEW_ID_IS_THE_FORWARD_SCRIPT');

  const lf = (s) => String(s ?? '').replace(/\r\n/g, '\n');
  if (lf(editorSource) !== lf(savedSource)) problems.push('SAVED_SOURCE_DIFFERS_FROM_EDITOR');

  return problems.length === 0
    ? { ok: true, newId, inventoryDelta: appeared }
    : { ok: false, problems, inventoryDelta: appeared };
}

// ── the unsaved-changes prompt ───────────────────────────────────────────────────
//
// Creating a new script while the editor is dirty makes TradingView ask what to do.
// On the build under test the choices read "Speichern" / "Nicht speichern" /
// "Abbrechen". Getting this wrong is not a cosmetic failure: "Speichern" persists the
// current buffer into whatever script is CURRENTLY BOUND, which is how a saved script
// was destroyed in this programme once already.
//
// So the discard button is identified POSITIVELY, by exact known label, and the save
// labels are an explicit never-click list. There is no positional fallback and no
// fuzzy match: an unrecognised locale must fail closed.

export const DISCARD_LABELS = Object.freeze([
  "Don't save", 'Do not save', 'Discard', 'Discard changes',
  'Nicht speichern', 'Verwerfen',
]);

export const NEVER_CLICK_LABELS = Object.freeze([
  'Save', 'Save script', 'Save changes',
  'Speichern', 'Skript speichern', 'Änderungen speichern',
]);

const eq = (a, b) => String(a ?? '').replace(/\s+/g, ' ').trim().toLowerCase()
  === String(b ?? '').replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * Is this the real unsaved-changes prompt? It must offer at least one recognised
 * discard option AND at least one recognised save option -- a container that merely
 * happens to hold several buttons (the editor status bar, for instance) does not.
 */
export function looksLikeUnsavedPrompt(buttonLabels = []) {
  const hasDiscard = buttonLabels.some(l => DISCARD_LABELS.some(d => eq(l, d)));
  const hasSave = buttonLabels.some(l => NEVER_CLICK_LABELS.some(d => eq(l, d)));
  return hasDiscard && hasSave;
}

/**
 * Choose the discard button. Returns `{ ok: true, index }` only when exactly one
 * button carries a known discard label and that button is not also a save label.
 */
export function selectDiscardButton(buttonLabels = []) {
  const saveIdx = buttonLabels
    .map((l, i) => ({ l, i }))
    .filter(({ l }) => NEVER_CLICK_LABELS.some(d => eq(l, d)))
    .map(({ i }) => i);

  const hits = buttonLabels
    .map((l, i) => ({ l, i }))
    .filter(({ l }) => DISCARD_LABELS.some(d => eq(l, d)));

  if (hits.length === 0) {
    return { ok: false, reason: 'NO_KNOWN_DISCARD_LABEL', saw: buttonLabels.filter(Boolean).slice(0, 8) };
  }
  if (hits.length > 1) {
    return { ok: false, reason: 'AMBIGUOUS_DISCARD_LABEL', candidates: hits.map(h => h.i) };
  }
  if (saveIdx.includes(hits[0].i)) {
    return { ok: false, reason: 'DISCARD_CANDIDATE_IS_ALSO_A_SAVE_LABEL' };
  }
  return { ok: true, index: hits[0].i, label: hits[0].l, neverClick: saveIdx };
}
