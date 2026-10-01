import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_PROTECTED_SCRIPT_IDS,
  evaluatePreMutationGate,
  evaluateStaleProtectedBuffer,
  evaluateWriteIdentity,
} from '../src/core/pine_identity.js';
import { newScript, openScript } from '../src/core/pine.js';

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

describe('stale-buffer guard reaches openScript and newScript (completes WORKSTREAM D coverage)', () => {
  function safeDeps(overrides = {}) {
    return {
      ensurePineEditorOpen: async () => true,
      sleep: async () => {},
      protectedIds: new Set([PROTECTED_ID]),
      postconditionAttempts: 1,
      ...overrides,
    };
  }

  it('openScript stops with STOP_PROTECTED_STALE_BUFFER when the current buffer is a dirty protected one, even for a non-protected target', async () => {
    let navigated = false;
    const result = await openScript({
      name: 'Target',
      script_id: OTHER_ID,
      expected_script_id: OTHER_ID,
      _deps: safeDeps({
        listPersistentScripts: async () => [{ id: OTHER_ID, name: 'Target', revision: 1 }],
        getBoundIdentity: async () => provenIdentity(PROTECTED_ID, {
          buffer_state: 'MODIFIED_UNSAVED',
          unsaved_state: true,
        }),
        openScriptViaUi: async () => { navigated = true; return true; },
      }),
    });

    assert.equal(result.success, false);
    assert.equal(result.reason, 'STOP_PROTECTED_STALE_BUFFER');
    assert.equal(result.no_mutation, true);
    assert.equal(navigated, false, 'must never attempt navigation while the hazard is present');
  });

  it('newScript stops with STOP_PROTECTED_STALE_BUFFER before any UI create action', async () => {
    let createAttempted = false;
    const result = await newScript({
      type: 'indicator',
      expected_script_id: OTHER_ID,
      _deps: safeDeps({
        listPersistentScripts: async () => [{ id: OTHER_ID, name: 'Other', revision: 1 }],
        getBoundIdentity: async () => provenIdentity(PROTECTED_ID, {
          buffer_state: 'MODIFIED_UNSAVED',
          unsaved_state: true,
        }),
        createNewViaUi: async () => { createAttempted = true; return true; },
      }),
    });

    assert.equal(result.success, false);
    assert.equal(result.reason, 'STOP_PROTECTED_STALE_BUFFER');
    assert.equal(result.no_mutation, true);
    assert.equal(createAttempted, false, 'must never attempt script creation while the hazard is present');
  });
});
