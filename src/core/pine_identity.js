/**
 * Pure identity and policy helpers for Pine editor mutations.
 *
 * These helpers deliberately do not infer identity from a visible script title.
 * A browser-side binding signal must resolve to exactly one entry in TradingView's
 * persistent saved-script inventory before identity is considered proven.
 */

export const IDENTITY_CONFIDENCE = Object.freeze({
  PROVEN: 'PROVEN',
  UNPROVEN: 'UNPROVEN',
});

export const DEFAULT_PROTECTED_SCRIPT_IDS = Object.freeze([
  'USER;a30dc62e926b41338001d5b7357c6658',
]);

function clean(value) {
  return typeof value === 'string' ? value.trim() : '';
}

export function normalizeScriptId(value) {
  return clean(value);
}

export function configuredProtectedScriptIds(envValue = process.env.TV_MCP_PROTECTED_SCRIPT_IDS) {
  const configured = clean(envValue)
    .split(/[\n,]/)
    .map(normalizeScriptId)
    .filter(Boolean);
  return new Set([...DEFAULT_PROTECTED_SCRIPT_IDS, ...configured]);
}

function inventoryId(script) {
  return normalizeScriptId(script?.id ?? script?.script_id ?? script?.scriptIdPart);
}

function inventoryName(script) {
  return clean(script?.name ?? script?.scriptName ?? script?.scriptTitle) || null;
}

function inventoryRevision(script) {
  return script?.revision ?? script?.version ?? null;
}

function resolveCandidateId(candidate, inventory) {
  const raw = normalizeScriptId(candidate);
  if (!raw) return null;
  const exact = inventory.filter(script => inventoryId(script) === raw);
  if (exact.length === 1) return inventoryId(exact[0]);

  // Some editor stores expose scriptIdPart without the USER;/PUB; namespace.
  // Resolve that only when it maps uniquely to the persistent inventory.
  const suffix = raw.includes(';') ? raw.split(';').at(-1) : raw;
  const suffixMatches = inventory.filter(script => inventoryId(script).split(';').at(-1) === suffix);
  return suffixMatches.length === 1 ? inventoryId(suffixMatches[0]) : null;
}

function comparableSource(source) {
  return typeof source === 'string' ? source.replace(/\r\n/g, '\n') : null;
}

export function deriveBoundIdentity({ editorState = {}, inventory = [], savedSource = undefined } = {}) {
  const candidates = Array.isArray(editorState.binding_candidates)
    ? editorState.binding_candidates.map(candidate => (
      typeof candidate === 'string' ? candidate : candidate?.id
    )).filter(Boolean)
    : [];

  const resolvedIds = [...new Set(candidates
    .map(candidate => resolveCandidateId(candidate, inventory))
    .filter(Boolean))];

  let reason = null;
  if (!editorState.editor_visible) reason = 'EDITOR_NOT_VISIBLE';
  else if (candidates.length === 0) reason = 'NO_EDITOR_BINDING_SIGNAL';
  else if (resolvedIds.length === 0) reason = 'BOUND_ID_NOT_IN_PERSISTENT_INVENTORY';
  else if (resolvedIds.length > 1) reason = 'CONFLICTING_EDITOR_BINDING_SIGNALS';

  const proven = !reason && resolvedIds.length === 1;
  const boundId = proven ? resolvedIds[0] : null;
  const entry = proven ? inventory.find(script => inventoryId(script) === boundId) : null;
  const bufferSource = comparableSource(editorState.source);
  const persistentSource = comparableSource(savedSource);

  let unsavedState = null;
  let bufferState = editorState.editor_visible ? 'UNKNOWN' : 'EDITOR_UNAVAILABLE';
  if (editorState.editor_visible && candidates.length === 0) bufferState = 'UNBOUND';
  if (proven && persistentSource !== null && bufferSource !== null) {
    unsavedState = bufferSource !== persistentSource || editorState.dirty_hint === true;
    bufferState = unsavedState ? 'MODIFIED_UNSAVED' : 'LOADED_SAVED_REVISION';
  } else if (proven && editorState.dirty_hint === true) {
    unsavedState = true;
    bufferState = 'MODIFIED_UNSAVED';
  }

  const visibleTitle = clean(editorState.visible_title) || null;
  const boundName = entry ? inventoryName(entry) : null;

  return {
    success: true,
    bound_script_id: boundId,
    bound_script_name: boundName,
    bound_revision: entry ? inventoryRevision(entry) : null,
    buffer_state: bufferState,
    unsaved_state: unsavedState,
    identity_confidence: proven ? IDENTITY_CONFIDENCE.PROVEN : IDENTITY_CONFIDENCE.UNPROVEN,
    identity_reason: reason,
    visible_title: visibleTitle,
    visible_title_matches_identity: proven && visibleTitle && boundName
      ? visibleTitle.localeCompare(boundName, undefined, { sensitivity: 'accent' }) === 0
      : null,
    binding_signal_count: candidates.length,
    persistent_inventory_count: inventory.length,
  };
}

export function evaluateWriteIdentity({
  identity,
  expectedScriptId,
  protectedIds = configuredProtectedScriptIds(),
} = {}) {
  const expected = normalizeScriptId(expectedScriptId);
  const actual = normalizeScriptId(identity?.bound_script_id);
  const protectedSet = protectedIds instanceof Set ? protectedIds : new Set(protectedIds || []);
  const actualSuffix = actual.split(';').at(-1);
  const expectedSuffix = expected.split(';').at(-1);
  const protectedMatch = [...protectedSet].some(value => {
    const protectedId = normalizeScriptId(value);
    const protectedSuffix = protectedId.split(';').at(-1);
    return protectedId === actual || protectedId === expected
      || (protectedSuffix && (protectedSuffix === actualSuffix || protectedSuffix === expectedSuffix));
  });

  if (!expected) {
    return { ok: false, success: false, reason: 'EXPECTED_SCRIPT_ID_REQUIRED', no_mutation: true };
  }
  if (identity?.identity_confidence !== IDENTITY_CONFIDENCE.PROVEN || !actual) {
    return {
      ok: false, success: false, reason: 'IDENTITY_UNPROVEN', no_mutation: true,
      expected_script_id: expected, actual_bound_script_id: actual || null,
    };
  }
  if (protectedMatch) {
    return {
      ok: false, success: false, reason: 'PROTECTED_SCRIPT_ID', no_mutation: true,
      expected_script_id: expected, actual_bound_script_id: actual,
    };
  }
  if (actual !== expected) {
    return {
      ok: false, success: false, reason: 'IDENTITY_MISMATCH', no_mutation: true,
      expected_script_id: expected, actual_bound_script_id: actual,
    };
  }
  return {
    ok: true, success: true,
    expected_script_id: expected,
    actual_bound_script_id: actual,
  };
}

/**
 * Detects the field-observed TradingView Desktop hazard: the Pine Editor's own
 * tab-restoration can surface a protected script's identity with foreign,
 * unsaved content whenever the editor panel is (re)opened — independent of any
 * MCP tool call. This must be checked before ANY save-capable mutation, not
 * only when the protected ID is the explicit expected_script_id target.
 */
export function evaluateStaleProtectedBuffer({
  identity,
  protectedIds = configuredProtectedScriptIds(),
} = {}) {
  const protectedSet = protectedIds instanceof Set ? protectedIds : new Set(protectedIds || []);
  const actual = normalizeScriptId(identity?.bound_script_id);
  if (!actual) return { stale: false };

  const actualSuffix = actual.split(';').at(-1);
  const isProtected = [...protectedSet].some(value => {
    const protectedId = normalizeScriptId(value);
    const protectedSuffix = protectedId.split(';').at(-1);
    return protectedId === actual || (protectedSuffix && protectedSuffix === actualSuffix);
  });
  if (!isProtected) return { stale: false };

  const unsavedHazard = identity?.unsaved_state === true || identity?.buffer_state === 'MODIFIED_UNSAVED';
  if (!unsavedHazard) return { stale: false };

  return {
    stale: true,
    reason: 'STOP_PROTECTED_STALE_BUFFER',
    protected_script_id: actual,
    buffer_state: identity?.buffer_state || 'UNKNOWN',
  };
}

/**
 * Single pre-mutation gate composing the stale-protected-buffer hazard check
 * with the existing expected-identity gate. Every save-capable mutation path
 * must route through this, not evaluateWriteIdentity alone, so the hazard
 * check cannot be silently skipped by a new call site.
 */
export function evaluatePreMutationGate({
  identity,
  expectedScriptId,
  protectedIds = configuredProtectedScriptIds(),
} = {}) {
  const staleGuard = evaluateStaleProtectedBuffer({ identity, protectedIds });
  if (staleGuard.stale) {
    return {
      ok: false,
      success: false,
      reason: staleGuard.reason,
      no_mutation: true,
      downstream_write_authority: false,
      protected_script_id: staleGuard.protected_script_id,
      buffer_state: staleGuard.buffer_state,
    };
  }
  return evaluateWriteIdentity({ identity, expectedScriptId, protectedIds });
}

export function resolveRequestedScript({ inventory = [], scriptId, name } = {}) {
  const requestedId = normalizeScriptId(scriptId);
  if (requestedId) {
    const matches = inventory.filter(script => inventoryId(script) === requestedId);
    if (matches.length !== 1) {
      return { success: false, reason: 'SCRIPT_ID_NOT_FOUND', requested_script_id: requestedId };
    }
    return { success: true, script: matches[0], resolved_script_id: inventoryId(matches[0]) };
  }

  const requestedName = clean(name);
  if (!requestedName) return { success: false, reason: 'SCRIPT_NAME_OR_ID_REQUIRED' };
  const folded = requestedName.toLocaleLowerCase();
  const exact = inventory.filter(script => inventoryName(script)?.toLocaleLowerCase() === folded);
  if (exact.length === 1) {
    return { success: true, script: exact[0], resolved_script_id: inventoryId(exact[0]) };
  }
  if (exact.length > 1) {
    return { success: false, reason: 'AMBIGUOUS_SCRIPT_NAME', match_count: exact.length };
  }
  const partial = inventory.filter(script => inventoryName(script)?.toLocaleLowerCase().includes(folded));
  if (partial.length === 1) {
    return { success: true, script: partial[0], resolved_script_id: inventoryId(partial[0]) };
  }
  return {
    success: false,
    reason: partial.length > 1 ? 'AMBIGUOUS_SCRIPT_NAME' : 'SCRIPT_NAME_NOT_FOUND',
    match_count: partial.length,
  };
}

export function addedPersistentScriptIds(before = [], after = []) {
  const beforeIds = new Set(before.map(inventoryId).filter(Boolean));
  return [...new Set(after.map(inventoryId).filter(id => id && !beforeIds.has(id)))];
}
