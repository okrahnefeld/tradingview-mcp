import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_PROTECTED_SCRIPT_IDS,
  evaluatePreMutationGate,
  evaluateStaleProtectedBuffer,
  evaluateWriteIdentity,
} from '../src/core/pine_identity.js';

const PROTECTED_ID = DEFAULT_PROTECTED_SCRIPT_IDS[0];
const OTHER_ID = 'USER;33333333333333333333333333333333';

function provenIdentity(id, overrides = {}) {
  return {
    success: true,
    bound_script_id: id,
    identity_confidence: 'PROVEN',
    buffer_state: 'LOADED_SAVED_REVISION',
    unsaved_state: false,
    ...overrides,
  };
}

describe('evaluateStaleProtectedBuffer (WORKSTREAM D field hazard guard)', () => {
  it('flags a protected ID bound with an unsaved/modified buffer', () => {
    const result = evaluateStaleProtectedBuffer({
      identity: provenIdentity(PROTECTED_ID, { buffer_state: 'MODIFIED_UNSAVED', unsaved_state: true }),
      protectedIds: new Set([PROTECTED_ID]),
    });
    assert.equal(result.stale, true);
    assert.equal(result.reason, 'STOP_PROTECTED_STALE_BUFFER');
    assert.equal(result.protected_script_id, PROTECTED_ID);
  });

  it('flags via suffix-only match when the platform exposes only the ID suffix', () => {
    const suffix = PROTECTED_ID.split(';').at(-1);
    const result = evaluateStaleProtectedBuffer({
      identity: provenIdentity(suffix, { buffer_state: 'MODIFIED_UNSAVED', unsaved_state: true }),
      protectedIds: new Set([PROTECTED_ID]),
    });
    assert.equal(result.stale, true);
  });

  it('does not flag a protected ID whose buffer is clean/saved', () => {
    const result = evaluateStaleProtectedBuffer({
      identity: provenIdentity(PROTECTED_ID),
      protectedIds: new Set([PROTECTED_ID]),
    });
    assert.equal(result.stale, false);
  });

  it('does not flag a non-protected ID even when unsaved', () => {
    const result = evaluateStaleProtectedBuffer({
      identity: provenIdentity(OTHER_ID, { buffer_state: 'MODIFIED_UNSAVED', unsaved_state: true }),
      protectedIds: new Set([PROTECTED_ID]),
    });
    assert.equal(result.stale, false);
  });

  it('does not flag an unbound/unproven identity', () => {
    const result = evaluateStaleProtectedBuffer({
      identity: { bound_script_id: null, identity_confidence: 'UNPROVEN' },
      protectedIds: new Set([PROTECTED_ID]),
    });
    assert.equal(result.stale, false);
  });
});

describe('evaluatePreMutationGate (stale-buffer guard composed with the existing gate)', () => {
  it('fails closed with STOP_PROTECTED_STALE_BUFFER before any identity/expected-ID comparison', () => {
    const gate = evaluatePreMutationGate({
      identity: provenIdentity(PROTECTED_ID, { buffer_state: 'MODIFIED_UNSAVED', unsaved_state: true }),
      expectedScriptId: OTHER_ID, // deliberately NOT targeting the protected ID
      protectedIds: new Set([PROTECTED_ID]),
    });
    assert.equal(gate.ok, false);
    assert.equal(gate.reason, 'STOP_PROTECTED_STALE_BUFFER');
    assert.equal(gate.no_mutation, true);
    assert.equal(gate.downstream_write_authority, false);
  });

  it('falls through to the normal gate and preserves its exact result when no stale hazard exists', () => {
    const identity = provenIdentity(OTHER_ID);
    const viaComposedGate = evaluatePreMutationGate({
      identity,
      expectedScriptId: OTHER_ID,
      protectedIds: new Set([PROTECTED_ID]),
    });
    const viaDirectGate = evaluateWriteIdentity({
      identity,
      expectedScriptId: OTHER_ID,
      protectedIds: new Set([PROTECTED_ID]),
    });
    assert.deepEqual(viaComposedGate, viaDirectGate);
    assert.equal(viaComposedGate.ok, true);
  });

  it('still reaches PROTECTED_SCRIPT_ID for a clean-buffer protected-ID write attempt', () => {
    const gate = evaluatePreMutationGate({
      identity: provenIdentity(PROTECTED_ID),
      expectedScriptId: PROTECTED_ID,
      protectedIds: new Set([PROTECTED_ID]),
    });
    assert.equal(gate.ok, false);
    assert.equal(gate.reason, 'PROTECTED_SCRIPT_ID');
  });
});
