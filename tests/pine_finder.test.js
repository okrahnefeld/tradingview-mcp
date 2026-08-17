import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { FIND_MONACO } from '../src/core/pine.js';

function runFinder(memoizedProps) {
  const editor = { getValue() {}, setValue() {} };
  const env = { editor: { getEditors: () => [editor] } };
  const fiber = { memoizedProps: memoizedProps(env), return: null };
  const parent = { parentElement: null, __reactFiber$test: fiber };
  const container = { parentElement: parent };
  const document = {
    querySelector(selector) {
      assert.equal(selector, '.monaco-editor.pine-editor-monaco');
      return container;
    },
  };
  const find = new Function('document', `return (${FIND_MONACO});`);
  return { result: find(document), editor, env };
}

describe('Pine Monaco finder', () => {
  it('supports the current direct memoizedProps.monacoEnv binding', () => {
    const { result, editor, env } = runFinder((value) => ({ monacoEnv: value }));
    assert.deepEqual(result, { editor, env });
  });

  it('retains support for the legacy memoizedProps.value.monacoEnv binding', () => {
    const { result, editor, env } = runFinder((value) => ({ value: { monacoEnv: value } }));
    assert.deepEqual(result, { editor, env });
  });
});
