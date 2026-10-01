import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { compile, getBoundIdentity, newScript, openScript, save, setSource } from '../src/core/pine.js';
import {
  DEFAULT_PROTECTED_SCRIPT_IDS,
  deriveBoundIdentity,
  evaluateOpenNavigationGate,
  evaluateWriteIdentity,
} from '../src/core/pine_identity.js';

const OLD_ID = 'USER;11111111111111111111111111111111';
const TARGET_ID = 'USER;22222222222222222222222222222222';
const PROTECTED_ID = DEFAULT_PROTECTED_SCRIPT_IDS[0];

function provenIdentity(id, overrides = {}) {
  return {
    success: true,
    bound_script_id: id,
    bound_script_name: id === TARGET_ID ? 'Target' : 'Previous',
    bound_revision: 7,
    buffer_state: 'LOADED_SAVED_REVISION',
    unsaved_state: false,
    identity_confidence: 'PROVEN',
    ...overrides,
  };
}

function safeDeps(overrides = {}) {
  return {
    ensurePineEditorOpen: async () => true,
    sleep: async () => {},
    protectedIds: new Set(),
    postconditionAttempts: 1,
    readSavedSource: async () => 'saved source',
    ...overrides,
  };
}

describe('canonical Pine identity', () => {
  it('reads the bound ID and revision through persistent inventory and saved source', async () => {
    let savedSourceRequest = null;
    const identity = await getBoundIdentity({
      _deps: safeDeps({
        listPersistentScripts: async () => [{ id: OLD_ID, name: 'Previous', revision: 7 }],
        readEditorBindingState: async () => ({
          editor_visible: true,
          visible_title: 'Previous',
          source: 'saved source',
          binding_candidates: [{ id: OLD_ID, source: 'monaco_model_uri' }],
        }),
        readSavedSource: async (request) => {
          savedSourceRequest = request;
          return 'saved source';
        },
      }),
    });

    assert.equal(savedSourceRequest.scriptId, OLD_ID);
    assert.equal(savedSourceRequest.revision, 7);
    assert.equal(identity.bound_script_id, OLD_ID);
    assert.equal(identity.bound_revision, 7);
    assert.equal(identity.unsaved_state, false);
    assert.equal(identity.identity_confidence, 'PROVEN');
  });

  it('detects a visible buffer that differs from the persistent bound identity', () => {
    const identity = deriveBoundIdentity({
      editorState: {
        editor_visible: true,
        visible_title: 'Other visible title',
        source: '//@version=6\nindicator("Unsaved")',
        binding_candidates: [{ id: OLD_ID, source: 'react:scriptId' }],
      },
      inventory: [{ id: OLD_ID, name: 'Previous', revision: 7 }],
      savedSource: '//@version=6\nindicator("Saved")',
    });

    assert.equal(identity.identity_confidence, 'PROVEN');
    assert.equal(identity.bound_script_id, OLD_ID);
    assert.equal(identity.buffer_state, 'MODIFIED_UNSAVED');
    assert.equal(identity.unsaved_state, true);
    assert.equal(identity.visible_title_matches_identity, false);
  });

  it('does not infer identity from a visible title alone', () => {
    const identity = deriveBoundIdentity({
      editorState: { editor_visible: true, visible_title: 'Previous', source: 'same', binding_candidates: [] },
      inventory: [{ id: OLD_ID, name: 'Previous', revision: 7 }],
      savedSource: 'same',
    });

    assert.equal(identity.bound_script_id, null);
    assert.equal(identity.identity_confidence, 'UNPROVEN');
    assert.equal(identity.identity_reason, 'NO_EDITOR_BINDING_SIGNAL');
  });
});

describe('pine_open identity postcondition', () => {
  it('fails when UI navigation reports success but the previous script remains bound', async () => {
    let identityReads = 0;
    const result = await openScript({
      name: 'Target',
      expected_script_id: TARGET_ID,
      _deps: safeDeps({
        listPersistentScripts: async () => [
          { id: OLD_ID, name: 'Previous', revision: 7 },
          { id: TARGET_ID, name: 'Target', revision: 2 },
        ],
        getBoundIdentity: async () => {
          identityReads++;
          return provenIdentity(OLD_ID);
        },
        openScriptViaUi: async () => true,
      }),
    });

    assert.equal(identityReads, 2);
    assert.equal(result.success, false);
    assert.equal(result.reason, 'BINDING_NOT_PROVEN');
    assert.equal(result.requested_script_id, TARGET_ID);
    assert.equal(result.actual_bound_script_id, OLD_ID);
  });

  it('never translates navigation-only completion into success', async () => {
    const result = await openScript({
      script_id: TARGET_ID,
      expected_script_id: TARGET_ID,
      _deps: safeDeps({
        listPersistentScripts: async () => [
          { id: OLD_ID, name: 'Previous', revision: 7 },
          { id: TARGET_ID, name: 'Target', revision: 2 },
        ],
        getBoundIdentity: async () => provenIdentity(OLD_ID, {
          buffer_state: 'MODIFIED_UNSAVED',
          unsaved_state: true,
        }),
        openScriptViaUi: async () => true,
      }),
    });

    assert.equal(result.success, false);
    assert.equal(result.reason, 'NAVIGATION_STATE_UNSAFE');
  });
});

describe('pine_open cold navigation gate', () => {
  const inventory = [
    { id: OLD_ID, name: 'Previous', revision: 7 },
    { id: TARGET_ID, name: 'Target', revision: 2 },
  ];

  function unboundIdentity(overrides = {}) {
    return {
      success: true,
      bound_script_id: null,
      identity_confidence: 'UNPROVEN',
      buffer_state: 'UNBOUND',
      unsaved_state: null,
      ...overrides,
    };
  }

  it('allows navigation-only cold open from a clean UNBOUND editor to one persistent non-protected target', () => {
    const gate = evaluateOpenNavigationGate({
      identity: unboundIdentity(),
      targetScriptId: TARGET_ID,
      expectedTargetScriptId: TARGET_ID,
      inventory,
      protectedIds: new Set([PROTECTED_ID]),
    });
    assert.equal(gate.ok, true);
    assert.equal(gate.path, 'COLD_NAVIGATION');
    assert.equal(gate.navigation_only, true);
    assert.equal(gate.downstream_write_authority, false);
  });

  it('rejects a cold-open expected target mismatch', () => {
    const gate = evaluateOpenNavigationGate({
      identity: unboundIdentity(),
      targetScriptId: TARGET_ID,
      expectedTargetScriptId: OLD_ID,
      inventory,
      protectedIds: new Set([PROTECTED_ID]),
    });
    assert.equal(gate.ok, false);
    assert.equal(gate.reason, 'EXPECTED_TARGET_MISMATCH');
  });

  it('rejects a protected target from a clean UNBOUND editor', () => {
    const gate = evaluateOpenNavigationGate({
      identity: unboundIdentity(),
      targetScriptId: PROTECTED_ID,
      expectedTargetScriptId: PROTECTED_ID,
      inventory: [...inventory, { id: PROTECTED_ID, name: 'Forward', revision: 4 }],
      protectedIds: new Set([PROTECTED_ID]),
    });
    assert.equal(gate.ok, false);
    assert.equal(gate.reason, 'PROTECTED_SCRIPT_ID');
  });

  it('rejects unknown or unsafe cold state', () => {
    const gate = evaluateOpenNavigationGate({
      identity: unboundIdentity({ buffer_state: 'UNKNOWN' }),
      targetScriptId: TARGET_ID,
      expectedTargetScriptId: TARGET_ID,
      inventory,
      protectedIds: new Set([PROTECTED_ID]),
    });
    assert.equal(gate.ok, false);
    assert.equal(gate.reason, 'NAVIGATION_STATE_UNSAFE');
  });

  it('cold-opens successfully only after a clean persistent post-binding proof', async () => {
    let reads = 0;
    let inventoryReads = 0;
    const persistent = [
      { id: TARGET_ID, name: 'Target', title: 'Target', revision: 2, modified: 10 },
    ];
    const result = await openScript({
      script_id: TARGET_ID,
      expected_script_id: TARGET_ID,
      _deps: safeDeps({
        listPersistentScripts: async () => { inventoryReads++; return persistent; },
        readSavedSource: async () => '//@version=6\nindicator("Target")',
        getBoundIdentity: async () => {
          reads++;
          return reads === 1 ? unboundIdentity() : provenIdentity(TARGET_ID, { bound_revision: 2 });
        },
        openScriptViaUi: async () => true,
      }),
    });
    assert.equal(result.success, true);
    assert.equal(result.script_id, TARGET_ID);
    assert.equal(result.navigation_path, 'COLD_NAVIGATION');
    assert.equal(result.navigation_only, true);
    assert.equal(result.downstream_write_authority, false);
    assert.equal(result.postcondition_proof, 'PASSED');
    assert.ok(inventoryReads >= 2);
  });
});

describe('pine_new persistent identity proof', () => {
  it('returns TRANSIENT_UNBOUND_BUFFER when UI action creates no inventory object', async () => {
    const inventory = [{ id: OLD_ID, name: 'Previous', revision: 7 }];
    let listReads = 0;
    const result = await newScript({
      type: 'indicator',
      expected_script_id: OLD_ID,
      _deps: safeDeps({
        listPersistentScripts: async () => { listReads++; return inventory; },
        getBoundIdentity: async () => provenIdentity(OLD_ID, {
          buffer_state: listReads > 1 ? 'MODIFIED_UNSAVED' : 'LOADED_SAVED_REVISION',
          unsaved_state: listReads > 1,
        }),
        createNewViaUi: async () => true,
      }),
    });

    assert.equal(result.success, false);
    assert.equal(result.reason, 'TRANSIENT_UNBOUND_BUFFER');
    assert.equal(result.new_persistent_ids.length, 0);
    assert.equal(result.writes_requiring_persistent_identity_prohibited, true);
  });
});

describe('pre-write identity interlock', () => {
  it('blocks an unsaved buffer over the protected script', () => {
    const gate = evaluateWriteIdentity({
      identity: provenIdentity(PROTECTED_ID, { buffer_state: 'MODIFIED_UNSAVED', unsaved_state: true }),
      expectedScriptId: PROTECTED_ID,
      protectedIds: new Set([PROTECTED_ID]),
    });
    assert.equal(gate.ok, false);
    assert.equal(gate.reason, 'PROTECTED_SCRIPT_ID');
  });

  it('protects the configured object when the platform exposes only its ID suffix', () => {
    const suffix = PROTECTED_ID.split(';').at(-1);
    const gate = evaluateWriteIdentity({
      identity: provenIdentity(suffix),
      expectedScriptId: suffix,
      protectedIds: new Set([PROTECTED_ID]),
    });
    assert.equal(gate.ok, false);
    assert.equal(gate.reason, 'PROTECTED_SCRIPT_ID');
  });

  it('stops before save dispatch when the expected ID mismatches', async () => {
    let getClientCalls = 0;
    const result = await save({
      expected_script_id: TARGET_ID,
      _deps: safeDeps({
        getBoundIdentity: async () => provenIdentity(OLD_ID),
        getClient: async () => { getClientCalls++; throw new Error('must not dispatch'); },
      }),
    });

    assert.equal(result.success, false);
    assert.equal(result.reason, 'IDENTITY_MISMATCH');
    assert.equal(result.no_mutation, true);
    assert.equal(getClientCalls, 0);
  });

  it('blocks protected-ID source replacement before Monaco mutation', async () => {
    let evaluateCalls = 0;
    const result = await setSource({
      source: '//@version=6\nindicator("blocked")',
      expected_script_id: PROTECTED_ID,
      _deps: safeDeps({
        protectedIds: new Set([PROTECTED_ID]),
        getBoundIdentity: async () => provenIdentity(PROTECTED_ID, {
          buffer_state: 'MODIFIED_UNSAVED',
          unsaved_state: true,
        }),
        evaluate: async () => { evaluateCalls++; return true; },
      }),
    });

    assert.equal(result.success, false);
    // The stale-protected-buffer guard (WORKSTREAM D) now fires first for this
    // exact pattern (protected ID + unsaved buffer) — a more specific, earlier
    // diagnosis than the generic PROTECTED_SCRIPT_ID gate it used to hit.
    assert.equal(result.reason, 'STOP_PROTECTED_STALE_BUFFER');
    assert.equal(result.no_mutation, true);
    assert.equal(evaluateCalls, 0);
  });

  it('still blocks protected-ID writes when the buffer is not flagged unsaved', async () => {
    let evaluateCalls = 0;
    const result = await setSource({
      source: '//@version=6\nindicator("blocked")',
      expected_script_id: PROTECTED_ID,
      _deps: safeDeps({
        protectedIds: new Set([PROTECTED_ID]),
        getBoundIdentity: async () => provenIdentity(PROTECTED_ID),
        evaluate: async () => { evaluateCalls++; return true; },
      }),
    });

    assert.equal(result.success, false);
    assert.equal(result.reason, 'PROTECTED_SCRIPT_ID');
    assert.equal(evaluateCalls, 0);
  });

  it('allows the correct non-protected ID write path', async () => {
    let evaluateCalls = 0;
    const result = await setSource({
      source: '//@version=6\nindicator("safe")',
      expected_script_id: OLD_ID,
      _deps: safeDeps({
        getBoundIdentity: async () => provenIdentity(OLD_ID),
        evaluate: async () => { evaluateCalls++; return true; },
      }),
    });

    assert.equal(result.success, true);
    assert.equal(result.identity_guard, 'PASSED');
    assert.equal(result.script_id, OLD_ID);
    assert.equal(evaluateCalls, 1);
  });

  it('performs no compile mutation after a failed identity gate', async () => {
    let evaluateCalls = 0;
    let getClientCalls = 0;
    const result = await compile({
      expected_script_id: TARGET_ID,
      _deps: safeDeps({
        getBoundIdentity: async () => provenIdentity(OLD_ID),
        evaluate: async () => { evaluateCalls++; return 'should-not-run'; },
        getClient: async () => { getClientCalls++; return {}; },
      }),
    });

    assert.equal(result.success, false);
    assert.equal(result.reason, 'IDENTITY_MISMATCH');
    assert.equal(result.no_mutation, true);
    assert.equal(evaluateCalls, 0);
    assert.equal(getClientCalls, 0);
  });
});
