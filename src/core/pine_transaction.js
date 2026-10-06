/**
 * Single-use, process-local mutation transaction for one bounded source replacement.
 *
 * Why this exists. The pre-write identity proof available on this platform is
 * EXPECTED_TARGET_TITLE_SOURCE_MATCH: the editor buffer must still equal the script's
 * saved revision. Replacing the source is precisely what destroys that equality, so
 * the authorized mutation consumed the evidence its own follow-up steps required --
 * setSource passed, then smartCompile refused IDENTITY_UNPROVEN and save never ran.
 *
 * The fix is not to relax the guard. It is to prove identity ONCE, strongly, before
 * the write, and then carry that authority through exactly one replace/save cycle
 * under a different set of checks that do not depend on the old content:
 *
 *   PROVEN_PREWRITE -> SOURCE_REPLACED -> BUFFER_DIGEST_VERIFIED
 *   -> SAVE_DISPATCHED -> SAME_PERSISTENT_ID_VERIFIED
 *   -> PERSISTED_DIGEST_VERIFIED -> COMPLETE
 *
 * A first-class host script id was looked for first and rejected on evidence. The
 * host exposes ids in two places: a React effect dependency array (an undocumented
 * internal, reachable only below the collector's depth limit) and a `recentlyUsed`
 * list which contains the PROTECTED Forward script id. Neither is unambiguous or
 * independent of mutable editor state, and treating either as first-class identity
 * would be the same class of mistake as trusting a window title.
 *
 * Everything here is a pure function over explicit inputs so the adversarial suite
 * runs offline, with no TradingView and no browser.
 */

export const TXN_STATES = Object.freeze({
  PROVEN_PREWRITE: 'PROVEN_PREWRITE',
  SOURCE_REPLACED: 'SOURCE_REPLACED',
  BUFFER_DIGEST_VERIFIED: 'BUFFER_DIGEST_VERIFIED',
  SAVE_DISPATCHED: 'SAVE_DISPATCHED',
  SAME_PERSISTENT_ID_VERIFIED: 'SAME_PERSISTENT_ID_VERIFIED',
  PERSISTED_DIGEST_VERIFIED: 'PERSISTED_DIGEST_VERIFIED',
  COMPLETE: 'COMPLETE',
  CONSUMED: 'CONSUMED',
  FAILED: 'FAILED',
});

/** Default time-to-live. Short, because authority should not outlive its proof. */
export const TXN_TTL_MS = 120_000;

const deny = (reason, detail) => ({ ok: false, reason, ...(detail ? { detail } : {}) });

const inventoryId = (s) => (s && (s.script_id ?? s.id)) || null;
const inventoryName = (s) => (s && (s.name ?? s.scriptName)) || null;
const inventoryRevision = (s) => (s && (s.revision ?? null));
const inventoryModified = (s) => (s && (s.modified ?? null));

/** One active transaction per script id, process-local. */
const active = new Map();

export function _resetTransactionsForTests() {
  active.clear();
}

export function getTransaction(scriptId) {
  return active.get(scriptId) || null;
}

/**
 * Open a transaction. Every precondition the Director specified is required here,
 * because this is the only point at which identity is proven the strong way.
 */
export function beginTransaction({
  identity,
  inventory = [],
  expectedScriptId,
  protectedIds = new Set(),
  targetId,
  persistedDigest,
  intendedDigest,
  now = Date.now(),
  ttlMs = TXN_TTL_MS,
} = {}) {
  if (!expectedScriptId) return deny('EXPECTED_SCRIPT_ID_REQUIRED');
  if (!targetId) return deny('TARGET_ID_REQUIRED');
  if (!intendedDigest) return deny('INTENDED_DIGEST_REQUIRED');

  const prot = protectedIds instanceof Set ? protectedIds : new Set(protectedIds || []);
  if (prot.has(expectedScriptId)) return deny('EXPECTED_SCRIPT_IS_PROTECTED');

  if (!identity || identity.identity_confidence !== 'PROVEN') {
    return deny('IDENTITY_NOT_PROVEN', identity?.identity_confidence ?? null);
  }
  if (identity.bound_script_id !== expectedScriptId) {
    return deny('BOUND_ID_MISMATCH', identity.bound_script_id ?? null);
  }
  if (identity.buffer_state !== 'LOADED_SAVED_REVISION') {
    return deny('BUFFER_NOT_AT_SAVED_REVISION', identity.buffer_state ?? null);
  }
  if (identity.unsaved_state !== false) return deny('BUFFER_HAS_UNSAVED_CHANGES');

  const matches = inventory.filter(s => inventoryId(s) === expectedScriptId);
  if (matches.length !== 1) return deny('INVENTORY_MATCH_NOT_UNIQUE', matches.length);

  if (active.has(expectedScriptId)) {
    const existing = active.get(expectedScriptId);
    if (existing.state !== TXN_STATES.CONSUMED && existing.state !== TXN_STATES.FAILED
        && now - existing.createdAt < existing.ttlMs) {
      return deny('TRANSACTION_ALREADY_ACTIVE');
    }
  }

  const entry = matches[0];
  const txn = {
    expectedScriptId,
    persistentName: inventoryName(entry),
    persistentRevision: inventoryRevision(entry),
    persistentModified: inventoryModified(entry),
    persistedDigestBefore: persistedDigest ?? null,
    intendedDigest,
    targetId,
    protectedSnapshot: [...prot].sort(),
    inventoryIdsBefore: inventory.map(inventoryId).filter(Boolean).sort(),
    createdAt: now,
    ttlMs,
    state: TXN_STATES.PROVEN_PREWRITE,
    singleUse: true,
  };
  active.set(expectedScriptId, txn);
  return { ok: true, txn };
}

function liveness(txn, now) {
  if (!txn) return deny('NO_TRANSACTION');
  if (txn.state === TXN_STATES.CONSUMED) return deny('TRANSACTION_ALREADY_CONSUMED');
  if (txn.state === TXN_STATES.FAILED) return deny('TRANSACTION_FAILED');
  if (now - txn.createdAt >= txn.ttlMs) return deny('TRANSACTION_EXPIRED');
  return { ok: true };
}

export function markSourceReplaced({ txn, now = Date.now() } = {}) {
  const live = liveness(txn, now);
  if (!live.ok) return live;
  if (txn.state !== TXN_STATES.PROVEN_PREWRITE) return deny('BAD_STATE', txn.state);
  txn.state = TXN_STATES.SOURCE_REPLACED;
  return { ok: true, txn };
}

/**
 * Post-write verification. Deliberately does NOT look at the old source: that is the
 * whole point. Instead it pins down everything else that must not have moved.
 */
export function verifyAfterWrite({
  txn,
  identity,
  inventory = [],
  targetId,
  bufferDigest,
  protectedIds = new Set(),
  now = Date.now(),
} = {}) {
  const live = liveness(txn, now);
  if (!live.ok) return live;
  if (txn.state !== TXN_STATES.SOURCE_REPLACED) return deny('BAD_STATE', txn.state);

  if (targetId !== txn.targetId) return deny('TARGET_CHANGED_MID_TRANSACTION', targetId);

  const prot = protectedIds instanceof Set ? protectedIds : new Set(protectedIds || []);
  if (prot.has(txn.expectedScriptId)) return deny('EXPECTED_SCRIPT_BECAME_PROTECTED');
  const protNow = [...prot].sort();
  if (protNow.join(',') !== txn.protectedSnapshot.join(',')) {
    return deny('PROTECTED_SNAPSHOT_CHANGED', protNow.join(','));
  }

  const matches = inventory.filter(s => inventoryId(s) === txn.expectedScriptId);
  if (matches.length !== 1) return deny('PERSISTENT_OBJECT_GONE_OR_AMBIGUOUS', matches.length);

  // The visible name is a corroborating signal, never identity on its own.
  if (txn.persistentName && inventoryName(matches[0]) !== txn.persistentName) {
    return deny('PERSISTENT_NAME_CHANGED', inventoryName(matches[0]));
  }
  if (identity?.visible_title && txn.persistentName
      && identity.visible_title !== txn.persistentName) {
    return deny('VISIBLE_NAME_CHANGED', identity.visible_title);
  }

  const idsNow = inventory.map(inventoryId).filter(Boolean).sort();
  const appeared = idsNow.filter(id => !txn.inventoryIdsBefore.includes(id));
  if (appeared.length > 0) return deny('NEW_PERSISTENT_SCRIPT_APPEARED', appeared.join(','));

  if (!bufferDigest) return deny('BUFFER_DIGEST_REQUIRED');
  if (bufferDigest !== txn.intendedDigest) {
    return deny('BUFFER_DIGEST_MISMATCH', bufferDigest);
  }

  txn.state = TXN_STATES.BUFFER_DIGEST_VERIFIED;
  return { ok: true, txn };
}

export function markSaveDispatched({ txn, now = Date.now() } = {}) {
  const live = liveness(txn, now);
  if (!live.ok) return live;
  if (txn.state !== TXN_STATES.BUFFER_DIGEST_VERIFIED) return deny('BAD_STATE', txn.state);
  txn.state = TXN_STATES.SAVE_DISPATCHED;
  return { ok: true, txn };
}

/**
 * Post-save verification. Requires the same persistent id, the intended digest
 * actually persisted, no extra script created, and normal PROVEN binding restored --
 * so the transaction hands authority back to the ordinary guard rather than keeping it.
 */
export function verifyAfterSave({
  txn,
  identity,
  inventory = [],
  persistedDigest,
  now = Date.now(),
} = {}) {
  const live = liveness(txn, now);
  if (!live.ok) return live;
  if (txn.state !== TXN_STATES.SAVE_DISPATCHED) return deny('BAD_STATE', txn.state);

  const matches = inventory.filter(s => inventoryId(s) === txn.expectedScriptId);
  if (matches.length !== 1) return deny('PERSISTENT_ID_NOT_FOUND_AFTER_SAVE', matches.length);

  const idsNow = inventory.map(inventoryId).filter(Boolean).sort();
  const appeared = idsNow.filter(id => !txn.inventoryIdsBefore.includes(id));
  if (appeared.length > 0) return deny('EXTRA_SCRIPT_CREATED_BY_SAVE', appeared.join(','));

  if (!persistedDigest) return deny('PERSISTED_DIGEST_REQUIRED');
  if (persistedDigest !== txn.intendedDigest) {
    return deny('PERSISTED_DIGEST_MISMATCH', persistedDigest);
  }
  txn.state = TXN_STATES.PERSISTED_DIGEST_VERIFIED;

  if (!identity || identity.identity_confidence !== 'PROVEN'
      || identity.bound_script_id !== txn.expectedScriptId) {
    return deny('NORMAL_BINDING_NOT_RESTORED', identity?.identity_confidence ?? null);
  }

  txn.state = TXN_STATES.COMPLETE;
  return { ok: true, txn };
}

/** Consume on success or terminal failure. A consumed transaction can never be reused. */
export function consumeTransaction({ txn, outcome = 'COMPLETE' } = {}) {
  if (!txn) return deny('NO_TRANSACTION');
  txn.state = outcome === 'COMPLETE' ? TXN_STATES.CONSUMED : TXN_STATES.FAILED;
  active.delete(txn.expectedScriptId);
  return { ok: true, txn };
}
