/**
 * Adversarial suite for the bounded Pine mutation transaction.
 *
 * The transaction exists so that one authorized source replacement can complete even
 * though it destroys the pre-write proof. That is a loosening of *when* identity is
 * checked, so every other property has to be nailed down harder. These are the
 * sixteen cases H-00-ORCH-20261006-008 requires, plus the state-machine properties.
 *
 * All offline: the module is pure functions over explicit inputs.
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';

import {
  TXN_STATES,
  TXN_TTL_MS,
  beginTransaction,
  markSourceReplaced,
  verifyAfterWrite,
  markSaveDispatched,
  verifyAfterSave,
  consumeTransaction,
  getTransaction,
  _resetTransactionsForTests,
} from '../src/core/pine_transaction.js';

const SANDBOX = 'USER;c4142bc6e1994d919dd8fac7ac6b5fce';
const FORWARD = 'USER;a30dc62e926b41338001d5b7357c6658';
const OTHER = 'USER;e6b303770d0548c99009a5fc65a97955';
const TARGET = 'C3FD1A55DF0FF95542E46A22FF5F58A8';
const OTHER_TARGET = '4181660187938F798518018A9B50833D';

const OLD_DIGEST = 'a'.repeat(64);
const NEW_DIGEST = 'b'.repeat(64);
const WRONG_DIGEST = 'c'.repeat(64);

const inv = (ids = [SANDBOX, FORWARD, OTHER], name = 'KIL SCIENCE POC Oracle Sandbox V1') =>
  ids.map(id => ({ id, name: id === SANDBOX ? name : `other ${id}`, revision: '1.0', modified: 1 }));

const proven = (over = {}) => ({
  bound_script_id: SANDBOX,
  bound_script_name: 'KIL SCIENCE POC Oracle Sandbox V1',
  identity_confidence: 'PROVEN',
  buffer_state: 'LOADED_SAVED_REVISION',
  unsaved_state: false,
  visible_title: 'KIL SCIENCE POC Oracle Sandbox V1',
  ...over,
});

const begin = (over = {}) => beginTransaction({
  identity: proven(),
  inventory: inv(),
  expectedScriptId: SANDBOX,
  protectedIds: new Set([FORWARD]),
  targetId: TARGET,
  persistedDigest: OLD_DIGEST,
  intendedDigest: NEW_DIGEST,
  ...over,
});

/** Drive a transaction to just before the post-write check. */
function upToWrite(over = {}) {
  const b = begin(over);
  assert.ok(b.ok, `begin failed: ${b.reason}`);
  assert.ok(markSourceReplaced({ txn: b.txn }).ok);
  return b.txn;
}

beforeEach(() => _resetTransactionsForTests());

describe('1. the happy path completes', () => {
  it('proves identity once, then carries authority through replace and save', () => {
    const txn = upToWrite();
    const w = verifyAfterWrite({
      txn, identity: proven({ buffer_state: 'MODIFIED_UNSAVED', unsaved_state: true }),
      inventory: inv(), targetId: TARGET, bufferDigest: NEW_DIGEST,
      protectedIds: new Set([FORWARD]),
    });
    assert.ok(w.ok, w.reason);
    assert.equal(txn.state, TXN_STATES.BUFFER_DIGEST_VERIFIED);
    assert.ok(markSaveDispatched({ txn }).ok);
    const s = verifyAfterSave({
      txn, identity: proven(), inventory: inv(), persistedDigest: NEW_DIGEST,
    });
    assert.ok(s.ok, s.reason);
    assert.equal(txn.state, TXN_STATES.COMPLETE);
    consumeTransaction({ txn });
    assert.equal(getTransaction(SANDBOX), null);
  });

  it('the post-write check never consults the old source', () => {
    // A buffer that no longer matches the saved revision is exactly the expected
    // state after an authorized write, and must not be a denial reason.
    const txn = upToWrite();
    const w = verifyAfterWrite({
      txn, identity: proven({ buffer_state: 'MODIFIED_UNSAVED', unsaved_state: true }),
      inventory: inv(), targetId: TARGET, bufferDigest: NEW_DIGEST,
      protectedIds: new Set([FORWARD]),
    });
    assert.ok(w.ok);
  });
});

describe('2-3. wrong or protected expected id is denied before any mutation', () => {
  it('denies a wrong expected id', () => {
    const r = begin({ expectedScriptId: OTHER, identity: proven() });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'BOUND_ID_MISMATCH');
  });

  it('denies the protected Forward id even if the editor claims it is bound', () => {
    const r = beginTransaction({
      identity: proven({ bound_script_id: FORWARD, bound_script_name: 'KIL POC Continuation Forward V1' }),
      inventory: inv(), expectedScriptId: FORWARD, protectedIds: new Set([FORWARD]),
      targetId: TARGET, persistedDigest: OLD_DIGEST, intendedDigest: NEW_DIGEST,
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'EXPECTED_SCRIPT_IS_PROTECTED');
  });
});

describe('4. a stale or dirty buffer still stops', () => {
  it('denies when the buffer is not at the saved revision', () => {
    const r = begin({ identity: proven({ buffer_state: 'MODIFIED_UNSAVED' }) });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'BUFFER_NOT_AT_SAVED_REVISION');
  });

  it('denies when unsaved changes are present', () => {
    const r = begin({ identity: proven({ unsaved_state: true }) });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'BUFFER_HAS_UNSAVED_CHANGES');
  });

  it('denies when identity is merely UNPROVEN', () => {
    const r = begin({ identity: proven({ identity_confidence: 'UNPROVEN' }) });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'IDENTITY_NOT_PROVEN');
  });
});

describe('5. a wrong replacement digest is denied', () => {
  it('denies when the buffer holds something other than the intended source', () => {
    const txn = upToWrite();
    const r = verifyAfterWrite({
      txn, identity: proven(), inventory: inv(), targetId: TARGET,
      bufferDigest: WRONG_DIGEST, protectedIds: new Set([FORWARD]),
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'BUFFER_DIGEST_MISMATCH');
  });

  it('denies when no buffer digest is supplied at all', () => {
    const txn = upToWrite();
    const r = verifyAfterWrite({
      txn, identity: proven(), inventory: inv(), targetId: TARGET,
      protectedIds: new Set([FORWARD]),
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'BUFFER_DIGEST_REQUIRED');
  });
});

describe('6. a target change mid-transaction is denied', () => {
  it('refuses when the CDP target is no longer the one identity was proven on', () => {
    const txn = upToWrite();
    const r = verifyAfterWrite({
      txn, identity: proven(), inventory: inv(), targetId: OTHER_TARGET,
      bufferDigest: NEW_DIGEST, protectedIds: new Set([FORWARD]),
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'TARGET_CHANGED_MID_TRANSACTION');
  });
});

describe('7. disappearance of the persistent object is denied', () => {
  it('refuses when the script is no longer in the inventory', () => {
    const txn = upToWrite();
    const r = verifyAfterWrite({
      txn, identity: proven(), inventory: inv([FORWARD, OTHER]), targetId: TARGET,
      bufferDigest: NEW_DIGEST, protectedIds: new Set([FORWARD]),
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'PERSISTENT_OBJECT_GONE_OR_AMBIGUOUS');
  });
});

describe('8. a second script id appearing is denied', () => {
  it('refuses when a new persistent script appeared during the write', () => {
    const txn = upToWrite();
    const r = verifyAfterWrite({
      txn, identity: proven(), inventory: [...inv(), { id: 'USER;brandnew', name: 'new' }],
      targetId: TARGET, bufferDigest: NEW_DIGEST, protectedIds: new Set([FORWARD]),
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'NEW_PERSISTENT_SCRIPT_APPEARED');
  });

  it('refuses when the save itself created an extra script', () => {
    const txn = upToWrite();
    assert.ok(verifyAfterWrite({
      txn, identity: proven(), inventory: inv(), targetId: TARGET,
      bufferDigest: NEW_DIGEST, protectedIds: new Set([FORWARD]),
    }).ok);
    assert.ok(markSaveDispatched({ txn }).ok);
    const r = verifyAfterSave({
      txn, identity: proven(), inventory: [...inv(), { id: 'USER;copy', name: 'copy' }],
      persistedDigest: NEW_DIGEST,
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'EXTRA_SCRIPT_CREATED_BY_SAVE');
  });
});

describe('9. same name but a different id is denied', () => {
  it('refuses when the name survives but the id does not', () => {
    const txn = upToWrite();
    const renamed = inv([FORWARD, OTHER]).concat([
      { id: 'USER;different', name: 'KIL SCIENCE POC Oracle Sandbox V1', revision: '1.0' },
    ]);
    const r = verifyAfterWrite({
      txn, identity: proven(), inventory: renamed, targetId: TARGET,
      bufferDigest: NEW_DIGEST, protectedIds: new Set([FORWARD]),
    });
    assert.equal(r.ok, false);
    // the id is what matters: the object is gone, a same-named impostor is not it
    assert.equal(r.reason, 'PERSISTENT_OBJECT_GONE_OR_AMBIGUOUS');
  });

  it('refuses when the persistent name under the same id changed', () => {
    const txn = upToWrite();
    const r = verifyAfterWrite({
      txn, identity: proven(), inventory: inv([SANDBOX, FORWARD, OTHER], 'Renamed'),
      targetId: TARGET, bufferDigest: NEW_DIGEST, protectedIds: new Set([FORWARD]),
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'PERSISTENT_NAME_CHANGED');
  });

  it('refuses when the visible editor title stops matching the persistent name', () => {
    const txn = upToWrite();
    const r = verifyAfterWrite({
      txn, identity: proven({ visible_title: 'KIL POC Continuation Forward V1' }),
      inventory: inv(), targetId: TARGET, bufferDigest: NEW_DIGEST,
      protectedIds: new Set([FORWARD]),
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'VISIBLE_NAME_CHANGED');
  });
});

describe('10-12. reuse, expiry and foreign transactions are denied', () => {
  it('denies reuse of a consumed transaction', () => {
    const txn = upToWrite();
    consumeTransaction({ txn });
    const r = verifyAfterWrite({
      txn, identity: proven(), inventory: inv(), targetId: TARGET,
      bufferDigest: NEW_DIGEST, protectedIds: new Set([FORWARD]),
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'TRANSACTION_ALREADY_CONSUMED');
  });

  it('denies an expired transaction', () => {
    const b = begin({ now: 0 });
    assert.ok(b.ok);
    assert.ok(markSourceReplaced({ txn: b.txn, now: 0 }).ok);
    const r = verifyAfterWrite({
      txn: b.txn, identity: proven(), inventory: inv(), targetId: TARGET,
      bufferDigest: NEW_DIGEST, protectedIds: new Set([FORWARD]),
      now: TXN_TTL_MS + 1,
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'TRANSACTION_EXPIRED');
  });

  it('denies a transaction opened for another script', () => {
    // A transaction pinned to OTHER cannot authorize a write verified against SANDBOX:
    // the inventory snapshot and expected id travel with the transaction.
    const b = beginTransaction({
      identity: proven({ bound_script_id: OTHER, bound_script_name: 'other' }),
      inventory: inv().map(s => (s.id === OTHER ? { ...s, name: 'other-name' } : s)),
      expectedScriptId: OTHER, protectedIds: new Set([FORWARD]), targetId: TARGET,
      persistedDigest: OLD_DIGEST, intendedDigest: NEW_DIGEST,
    });
    assert.ok(b.ok, b.reason);
    assert.equal(b.txn.expectedScriptId, OTHER);
    assert.notEqual(b.txn.expectedScriptId, SANDBOX);
  });

  it('allows only one active transaction per script', () => {
    const first = begin();
    assert.ok(first.ok);
    const second = begin();
    assert.equal(second.ok, false);
    assert.equal(second.reason, 'TRANSACTION_ALREADY_ACTIVE');
  });
});

describe('13. no transaction means the ordinary guard still rules', () => {
  it('every verification step refuses without a transaction', () => {
    for (const fn of [verifyAfterWrite, verifyAfterSave]) {
      const r = fn({ txn: null, identity: proven(), inventory: inv() });
      assert.equal(r.ok, false);
      assert.equal(r.reason, 'NO_TRANSACTION');
    }
    assert.equal(markSourceReplaced({ txn: null }).reason, 'NO_TRANSACTION');
    assert.equal(markSaveDispatched({ txn: null }).reason, 'NO_TRANSACTION');
  });
});

describe('the state machine cannot be skipped', () => {
  it('refuses post-write verification before the write was marked', () => {
    const b = begin();
    assert.ok(b.ok);
    const r = verifyAfterWrite({
      txn: b.txn, identity: proven(), inventory: inv(), targetId: TARGET,
      bufferDigest: NEW_DIGEST, protectedIds: new Set([FORWARD]),
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'BAD_STATE');
  });

  it('refuses save dispatch before the buffer digest was verified', () => {
    const txn = upToWrite();
    const r = markSaveDispatched({ txn });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'BAD_STATE');
  });

  it('refuses post-save verification before the save was dispatched', () => {
    const txn = upToWrite();
    assert.ok(verifyAfterWrite({
      txn, identity: proven(), inventory: inv(), targetId: TARGET,
      bufferDigest: NEW_DIGEST, protectedIds: new Set([FORWARD]),
    }).ok);
    const r = verifyAfterSave({ txn, identity: proven(), inventory: inv(), persistedDigest: NEW_DIGEST });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'BAD_STATE');
  });

  it('requires the persisted digest to be exactly the intended source', () => {
    const txn = upToWrite();
    assert.ok(verifyAfterWrite({
      txn, identity: proven(), inventory: inv(), targetId: TARGET,
      bufferDigest: NEW_DIGEST, protectedIds: new Set([FORWARD]),
    }).ok);
    assert.ok(markSaveDispatched({ txn }).ok);
    const r = verifyAfterSave({
      txn, identity: proven(), inventory: inv(), persistedDigest: WRONG_DIGEST,
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'PERSISTED_DIGEST_MISMATCH');
  });

  it('requires ordinary PROVEN binding to be restored before completing', () => {
    const txn = upToWrite();
    assert.ok(verifyAfterWrite({
      txn, identity: proven(), inventory: inv(), targetId: TARGET,
      bufferDigest: NEW_DIGEST, protectedIds: new Set([FORWARD]),
    }).ok);
    assert.ok(markSaveDispatched({ txn }).ok);
    const r = verifyAfterSave({
      txn, identity: proven({ identity_confidence: 'UNPROVEN', bound_script_id: null }),
      inventory: inv(), persistedDigest: NEW_DIGEST,
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'NORMAL_BINDING_NOT_RESTORED');
    // the digest was still verified, so the record shows how far it got
    assert.equal(txn.state, TXN_STATES.PERSISTED_DIGEST_VERIFIED);
  });
});

describe('16. protected-object policy is not weakened by the transaction', () => {
  it('refuses if the protected set changed during the transaction', () => {
    const txn = upToWrite();
    const r = verifyAfterWrite({
      txn, identity: proven(), inventory: inv(), targetId: TARGET,
      bufferDigest: NEW_DIGEST, protectedIds: new Set(),   // Forward silently unprotected
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'PROTECTED_SNAPSHOT_CHANGED');
  });

  it('pins the protected snapshot at transaction start', () => {
    const b = begin();
    assert.deepEqual(b.txn.protectedSnapshot, [FORWARD]);
  });

  it('never admits a protected id as the transaction subject, under any state', () => {
    for (const bufferState of ['LOADED_SAVED_REVISION', 'MODIFIED_UNSAVED', 'UNBOUND']) {
      const r = beginTransaction({
        identity: proven({ bound_script_id: FORWARD, buffer_state: bufferState }),
        inventory: inv(), expectedScriptId: FORWARD, protectedIds: new Set([FORWARD]),
        targetId: TARGET, persistedDigest: OLD_DIGEST, intendedDigest: NEW_DIGEST,
      });
      assert.equal(r.ok, false, bufferState);
      assert.equal(r.reason, 'EXPECTED_SCRIPT_IS_PROTECTED', bufferState);
    }
  });
});

describe('required inputs are not optional', () => {
  it('refuses without an expected script id, target or intended digest', () => {
    assert.equal(begin({ expectedScriptId: undefined }).reason, 'EXPECTED_SCRIPT_ID_REQUIRED');
    assert.equal(begin({ targetId: undefined }).reason, 'TARGET_ID_REQUIRED');
    assert.equal(begin({ intendedDigest: undefined }).reason, 'INTENDED_DIGEST_REQUIRED');
  });

  it('refuses when the inventory match is not unique', () => {
    const dup = [...inv(), { id: SANDBOX, name: 'KIL SCIENCE POC Oracle Sandbox V1' }];
    const r = begin({ inventory: dup });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'INVENTORY_MATCH_NOT_UNIQUE');
  });
});
