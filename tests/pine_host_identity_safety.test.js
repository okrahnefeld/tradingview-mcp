/**
 * Adversarial tests for the host-native active-script binding signal.
 *
 * This build exposes TradingView's own editor facade, whose getScriptIdVersion() names
 * the saved script the editor is actually bound to -- independently of the buffer
 * contents, the window title and the React fiber tree. That makes it the strongest
 * signal available, and it works on builds where the Monaco container is mounted
 * detached and every other signal goes blind.
 *
 * Adding a stronger signal is only safe if it cannot manufacture a binding. The rules it
 * passes through are unchanged: a candidate must resolve UNIQUELY in persistent
 * inventory, conflicting candidates fail closed, and a protected id is never usable as a
 * write target. These tests pin that, including the case that made the obvious
 * alternative unusable -- the recently-used list, which names ids whether or not the
 * script is open.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';

import { deriveBoundIdentity } from '../src/core/pine_identity.js';

const V2 = 'USER;5cda1b209a0a4159ab2034c64636eee8';
const V1 = 'USER;ed81d4ce4c7640d9a554591a5bff731a';
const FORWARD = 'USER;a30dc62e926b41338001d5b7357c6658';
const SANDBOX = 'USER;c4142bc6e1994d919dd8fac7ac6b5fce';

const inv = (ids = [V2, V1, FORWARD, SANDBOX]) => ids.map(id => ({
  scriptIdPart: id,
  scriptName: id === V2 ? 'KIL SCIENCE POC Deep Transport V2' : `name ${id.slice(5, 12)}`,
  version: '1.0',
}));

/** Editor state as the collector reports it when only the host signal is available. */
const hostOnly = (id, over = {}) => ({
  editor_visible: true,
  source: undefined,
  visible_title: null,
  dirty_hint: false,
  host_active_script: { id, version: '1.0', modified: false, draft: false },
  binding_candidates: [{ id, source: 'host_active_script' }],
  ...over,
});

describe('1. the exact host id binds', () => {
  it('proves the V2 slot from the host readback alone', () => {
    const r = deriveBoundIdentity({ editorState: hostOnly(V2), inventory: inv() });
    assert.equal(r.bound_script_id, V2);
    assert.equal(r.identity_confidence, 'PROVEN');
    assert.equal(r.bound_revision, '1.0');
  });

  it('works when no Monaco source is reachable at all', () => {
    // source undefined is the detached-editor case; it must not block the proof
    const r = deriveBoundIdentity({ editorState: hostOnly(V2), inventory: inv() });
    assert.equal(r.identity_confidence, 'PROVEN');
    assert.equal(r.binding_signal_count, 1);
  });
});

describe('2-3. a wrong or protected id does not become a write target', () => {
  it('binds whatever the host names, which for a wrong id is NOT the expected one', () => {
    const r = deriveBoundIdentity({ editorState: hostOnly(V1), inventory: inv() });
    assert.equal(r.bound_script_id, V1);
    assert.notEqual(r.bound_script_id, V2);
  });

  it('reports the protected Forward id truthfully rather than hiding it', () => {
    // Honesty here is what lets the write gate refuse: the collector must not mask it.
    const r = deriveBoundIdentity({ editorState: hostOnly(FORWARD), inventory: inv() });
    assert.equal(r.bound_script_id, FORWARD);
    assert.equal(r.identity_confidence, 'PROVEN');
  });

  it('never silently substitutes the expected id for the reported one', () => {
    for (const reported of [V1, FORWARD, SANDBOX]) {
      const r = deriveBoundIdentity({ editorState: hostOnly(reported), inventory: inv() });
      assert.equal(r.bound_script_id, reported);
    }
  });
});

describe('4. an absent host id fails closed', () => {
  it('is UNPROVEN when the host names nothing and no other signal exists', () => {
    const r = deriveBoundIdentity({
      editorState: { editor_visible: true, binding_candidates: [], host_active_script: null },
      inventory: inv(),
    });
    assert.equal(r.identity_confidence, 'UNPROVEN');
    assert.equal(r.identity_reason, 'NO_EDITOR_BINDING_SIGNAL');
    assert.equal(r.bound_script_id, null);
  });

  it('is UNPROVEN when there is no editor and no host signal', () => {
    const r = deriveBoundIdentity({ editorState: { editor_visible: false }, inventory: inv() });
    assert.equal(r.identity_confidence, 'UNPROVEN');
    assert.equal(r.identity_reason, 'EDITOR_NOT_VISIBLE');
  });
});

describe('5. the id must resolve uniquely in persistent inventory', () => {
  it('fails closed when the host names an id that is not saved', () => {
    const r = deriveBoundIdentity({
      editorState: hostOnly('USER;neverSavedAnywhere00000000000'),
      inventory: inv(),
    });
    assert.equal(r.identity_confidence, 'UNPROVEN');
    assert.equal(r.identity_reason, 'BOUND_ID_NOT_IN_PERSISTENT_INVENTORY');
  });

  it('fails closed when inventory holds the id twice', () => {
    const dup = [...inv(), { scriptIdPart: V2, scriptName: 'impostor', version: '9.0' }];
    const r = deriveBoundIdentity({ editorState: hostOnly(V2), inventory: dup });
    // a duplicate id cannot identify one object
    assert.notEqual(r.identity_confidence, 'PROVEN');
  });

  it('fails closed on an empty inventory', () => {
    const r = deriveBoundIdentity({ editorState: hostOnly(V2), inventory: [] });
    assert.equal(r.identity_confidence, 'UNPROVEN');
    assert.equal(r.identity_reason, 'BOUND_ID_NOT_IN_PERSISTENT_INVENTORY');
  });
});

describe('6. conflicting signals fail closed', () => {
  it('refuses when the host and another signal name different scripts', () => {
    const state = hostOnly(V2);
    state.binding_candidates = [
      { id: V2, source: 'host_active_script' },
      { id: V1, source: 'react:fiber3.state.scriptIdPart' },
    ];
    const r = deriveBoundIdentity({ editorState: state, inventory: inv() });
    assert.equal(r.identity_confidence, 'UNPROVEN');
    assert.equal(r.identity_reason, 'CONFLICTING_EDITOR_BINDING_SIGNALS');
  });

  it('refuses even when the conflicting other signal is the protected script', () => {
    const state = hostOnly(V2);
    state.binding_candidates = [
      { id: V2, source: 'host_active_script' },
      { id: FORWARD, source: 'dom:data-script-id' },
    ];
    const r = deriveBoundIdentity({ editorState: state, inventory: inv() });
    assert.equal(r.identity_confidence, 'UNPROVEN');
    assert.equal(r.identity_reason, 'CONFLICTING_EDITOR_BINDING_SIGNALS');
  });

  it('accepts agreement between the host and another signal', () => {
    const state = hostOnly(V2);
    state.binding_candidates = [
      { id: V2, source: 'host_active_script' },
      { id: V2, source: 'monaco_model_uri' },
    ];
    const r = deriveBoundIdentity({ editorState: state, inventory: inv() });
    assert.equal(r.identity_confidence, 'PROVEN');
    assert.equal(r.bound_script_id, V2);
  });
});

describe('title and source are still not identity', () => {
  it('a matching title alone proves nothing', () => {
    const r = deriveBoundIdentity({
      editorState: {
        editor_visible: true, binding_candidates: [],
        visible_title: 'KIL SCIENCE POC Deep Transport V2', host_active_script: null,
      },
      inventory: inv(),
    });
    assert.equal(r.identity_confidence, 'UNPROVEN');
  });

  it('a matching source alone proves nothing', () => {
    const r = deriveBoundIdentity({
      editorState: { editor_visible: true, binding_candidates: [], source: 'strategy("x")' },
      inventory: inv(),
      savedSource: 'strategy("x")',
    });
    assert.equal(r.identity_confidence, 'UNPROVEN');
  });

  it('a recently-used-style id is not admitted as a host signal', () => {
    // The guard is that only getScriptIdVersion feeds host_active_script. A candidate
    // sourced from a recently-used list must look like any other weak signal, and on its
    // own alongside a differing host id it must conflict rather than win.
    const state = hostOnly(V2);
    state.binding_candidates = [
      { id: V2, source: 'host_active_script' },
      { id: SANDBOX, source: 'react:fiber10.state.ui.recentlyUsed.1.scriptIdPart' },
    ];
    const r = deriveBoundIdentity({ editorState: state, inventory: inv() });
    assert.equal(r.identity_confidence, 'UNPROVEN');
    assert.equal(r.identity_reason, 'CONFLICTING_EDITOR_BINDING_SIGNALS');
  });
});

describe('buffer cleanliness is reported, not assumed', () => {
  it('marks the buffer modified when the host says so', () => {
    const state = hostOnly(V2, { dirty_hint: true });
    state.host_active_script.modified = true;
    const r = deriveBoundIdentity({ editorState: state, inventory: inv() });
    assert.equal(r.identity_confidence, 'PROVEN');
    assert.equal(r.buffer_state, 'MODIFIED_UNSAVED');
    assert.equal(r.unsaved_state, true);
  });

  it('reports LOADED_SAVED_REVISION when buffer and saved source agree', () => {
    const state = hostOnly(V2, { source: 'strategy("x")\n' });
    const r = deriveBoundIdentity({
      editorState: state, inventory: inv(), savedSource: 'strategy("x")\n',
    });
    assert.equal(r.buffer_state, 'LOADED_SAVED_REVISION');
    assert.equal(r.unsaved_state, false);
  });
});
