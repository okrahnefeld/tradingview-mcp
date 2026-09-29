# Tooling Hazard: Pine Editor Buffer / Identity Split-Brain

Status: repaired offline; bounded live validation pending

Hazard: `EDITOR_BUFFER_IDENTITY_SPLIT_BRAIN`

Related record: `INC-20260927-001` (this document records the tooling defect; it is not a new Forward incident)

## Failure mode

The former `pine_open` implementation resolved a saved script through
`pine-facade/list/?filter=saved`, fetched its source, injected that source with
Monaco `setValue()`, and returned `opened: true`. It never caused or proved a
TradingView saved-script binding change. The former `pine_new` implementation
also only injected a template with `setValue()` and returned
`new_script_created`. In both operations, a visible buffer change was mistaken
for a persistent object identity change.

That conflated distinct states: editor visibility, Monaco buffer availability,
visible menu/title text, persistent saved-script identity, unsaved buffer state,
and active chart study state. A buffer could therefore display one script while
save/compile still acted on a different persistent `SCRIPT_ID`.

The orchestration-level pre-write read-back guard prevented a subsequent write
to the wrong object. That control was effective, but it was outside the MCP
mutation and could not make `pine_open` or `pine_new` success truthful.

## Fail-closed repair

`pine_get_bound_identity` is now the canonical read-only identity primitive. It
collects an editor binding signal (never title alone), resolves that signal
uniquely against TradingView's persistent saved-script inventory, and compares
the visible buffer with the saved revision when the revision source is
available. It reports:

- `bound_script_id`
- `bound_script_name`
- `bound_revision`
- `buffer_state`
- `unsaved_state`
- `identity_confidence` (`PROVEN` or `UNPROVEN`)

No unique binding signal plus persistent inventory match means `UNPROVEN`.
Visible title is diagnostic only.

`pine_open` now uses native UI navigation and succeeds only when the requested
or uniquely resolved persistent ID equals the post-navigation bound ID and the
loaded buffer is the saved revision. Navigation without binding proof returns
`BINDING_NOT_PROVEN`.

`pine_new` snapshots the prior bound ID and saved inventory, invokes the native
new-script UI, and succeeds only if exactly one previously absent persistent ID
appears and becomes the proven binding. When TradingView produces only a new
unsaved buffer, it returns `TRANSIENT_UNBOUND_BUFFER` with `success: false`.

`pine_set_source`, `pine_save`, `pine_compile`, and `pine_smart_compile` require
`expected_script_id`. Each checks the proven actual binding inside the core
operation immediately before mutation. Missing expectation, unproven identity,
mismatch, or policy denial returns failure with `no_mutation: true`.

## Protected IDs

The default denylist contains:

```text
USER;a30dc62e926b41338001d5b7357c6658
```

Additional IDs can be supplied through `TV_MCP_PROTECTED_SCRIPT_IDS`, separated
by commas or newlines. Defaults are additive and cannot be removed through that
setting. Protection is evaluated against persistent IDs, never visible titles.

## Copy primitive review

`pine_copy_script(source_script_id)` is designed but not exposed. A safe copy
must snapshot inventory, prove the source identity, invoke TradingView's native
copy action, observe exactly one new inventory ID, prove `NEW_ID != SOURCE_ID`,
and prove the editor is bound to the new persisted ID. Any ambiguity must return
failure. No stable native selector/API was verified offline, and live mutation
was prohibited for this repair, so implementing an operational copy tool would
claim more assurance than is available.

Rename, restore, delete, and copy are not currently exposed by this repository.
Any future implementation must use the same in-operation expected-ID and
protected-ID gate immediately before its mutation.

## Validation boundary

Regression coverage uses mocked TradingView state and includes split-brain
buffers, navigation false-success, transient new buffers, protected IDs,
expected-ID mismatch, allowed writes, and proof that failed gates perform no
mutation. No live TradingView write or Forward object access is part of this
repair. Bounded live validation remains a separate objective.
