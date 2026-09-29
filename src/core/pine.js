/**
 * Core Pine Script logic — shared between MCP tools and CLI.
 * All functions accept plain options objects and return plain JS objects.
 * They throw on error (callers catch and format).
 */
import { evaluate, evaluateAsync, getClient } from '../connection.js';
import {
  addedPersistentScriptIds,
  configuredProtectedScriptIds,
  deriveBoundIdentity,
  evaluateWriteIdentity,
  resolveRequestedScript,
} from './pine_identity.js';

// ── Monaco finder (injected into TV page) ──
const FIND_MONACO = `
  (function findMonacoEditor() {
    var container = document.querySelector('.monaco-editor.pine-editor-monaco');
    if (!container) return null;
    var el = container;
    var fiberKey;
    for (var i = 0; i < 20; i++) {
      if (!el) break;
      fiberKey = Object.keys(el).find(function(k) { return k.startsWith('__reactFiber$'); });
      if (fiberKey) break;
      el = el.parentElement;
    }
    if (!fiberKey) return null;
    var current = el[fiberKey];
    for (var d = 0; d < 15; d++) {
      if (!current) break;
      if (current.memoizedProps && current.memoizedProps.value && current.memoizedProps.value.monacoEnv) {
        var env = current.memoizedProps.value.monacoEnv;
        if (env.editor && typeof env.editor.getEditors === 'function') {
          var editors = env.editor.getEditors();
          if (editors.length > 0) return { editor: editors[0], env: env };
        }
      }
      current = current.return;
    }
    return null;
  })()
`;

/**
 * Opens the Pine Editor panel and waits for Monaco to become available.
 * Returns true if editor is accessible, false on timeout.
 */
export async function ensurePineEditorOpen({ _deps = {} } = {}) {
  const _evaluate = _deps.evaluate || evaluate;
  const _sleep = _deps.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const already = await _evaluate(`
    (function() {
      var m = ${FIND_MONACO};
      return m !== null;
    })()
  `);
  if (already) return true;

  await _evaluate(`
    (function() {
      var bwb = window.TradingView && window.TradingView.bottomWidgetBar;
      if (!bwb) return;
      if (typeof bwb.activateScriptEditorTab === 'function') bwb.activateScriptEditorTab();
      else if (typeof bwb.showWidget === 'function') bwb.showWidget('pine-editor');
    })()
  `);

  await _evaluate(`
    (function() {
      var btn = document.querySelector('[aria-label="Pine"]')
        || document.querySelector('[data-name="pine-dialog-button"]');
      if (btn) btn.click();
    })()
  `);

  for (let i = 0; i < 50; i++) {
    await _sleep(200);
    const ready = await _evaluate(`(function() { return ${FIND_MONACO} !== null; })()`);
    if (ready) return true;
  }
  return false;
}

function dependencies(_deps = {}) {
  return {
    evaluate: _deps.evaluate || evaluate,
    evaluateAsync: _deps.evaluateAsync || evaluateAsync,
    getClient: _deps.getClient || getClient,
    ensurePineEditorOpen: _deps.ensurePineEditorOpen
      || (() => ensurePineEditorOpen({ _deps })),
    sleep: _deps.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms))),
    getBoundIdentity: _deps.getBoundIdentity || getBoundIdentity,
    listPersistentScripts: _deps.listPersistentScripts || listPersistentScripts,
    readEditorBindingState: _deps.readEditorBindingState || readEditorBindingState,
    readSavedSource: _deps.readSavedSource || readSavedSource,
    openScriptViaUi: _deps.openScriptViaUi || openScriptViaUi,
    createNewViaUi: _deps.createNewViaUi || createNewViaUi,
    protectedIds: _deps.protectedIds || configuredProtectedScriptIds(),
    postconditionAttempts: _deps.postconditionAttempts || 12,
  };
}

async function listPersistentScripts({ _deps = {} } = {}) {
  const _evaluateAsync = _deps.evaluateAsync || evaluateAsync;
  const result = await _evaluateAsync(`
    fetch('https://pine-facade.tradingview.com/pine-facade/list/?filter=saved', { credentials: 'include' })
      .then(function(response) {
        if (!response.ok) throw new Error('pine-facade list returned HTTP ' + response.status);
        return response.json();
      })
      .then(function(data) {
        if (!Array.isArray(data)) return { scripts: [], error: 'Unexpected response from pine-facade' };
        return {
          scripts: data.map(function(script) {
            return {
              id: script.scriptIdPart || null,
              name: script.scriptName || script.scriptTitle || 'Untitled',
              title: script.scriptTitle || null,
              revision: script.version || null,
              modified: script.modified || null
            };
          })
        };
      })
      .catch(function(error) { return { scripts: [], error: error.message }; })
  `);
  if (result?.error) throw new Error(`Persistent Pine inventory unavailable: ${result.error}`);
  return result?.scripts || [];
}

async function readEditorBindingState({ _deps = {} } = {}) {
  const _evaluate = _deps.evaluate || evaluate;
  return _evaluate(`
    (function() {
      var monaco = ${FIND_MONACO};
      if (!monaco) return { editor_visible: false, binding_candidates: [] };
      var model = monaco.editor.getModel ? monaco.editor.getModel() : null;
      var container = document.querySelector('.monaco-editor.pine-editor-monaco');
      var candidates = [];
      var seen = {};
      var visibleTitle = null;
      var dirtyHint = false;

      function addCandidate(value, source) {
        if (typeof value !== 'string') return;
        var decoded = value;
        try { decoded = decodeURIComponent(value); } catch (_) {}
        var matches = decoded.match(/(?:USER|PUB|STD);[A-Za-z0-9_-]+/g) || [];
        if (matches.length === 0 && /^[a-f0-9-]{24,}$/i.test(decoded.trim())) matches = [decoded.trim()];
        for (var i = 0; i < matches.length; i++) {
          var key = matches[i] + '|' + source;
          if (!seen[key]) { candidates.push({ id: matches[i], source: source }); seen[key] = true; }
        }
      }

      if (model && model.uri) addCandidate(String(model.uri), 'monaco_model_uri');
      var node = container;
      for (var level = 0; node && level < 12; level++, node = node.parentElement) {
        var attrs = ['data-script-id', 'data-scriptid', 'data-script-id-part', 'data-pine-id'];
        for (var a = 0; a < attrs.length; a++) {
          if (node.hasAttribute && node.hasAttribute(attrs[a])) addCandidate(node.getAttribute(attrs[a]), 'dom:' + attrs[a]);
        }
      }

      var titleNode = document.querySelector('[data-name="script-title"]')
        || document.querySelector('[data-name="pine-script-name"]')
        || document.querySelector('[class*="scriptTitle"]');
      if (titleNode) visibleTitle = titleNode.textContent.trim() || null;
      var unsavedNode = document.querySelector('[data-name*="unsaved"], [aria-label*="unsaved" i], [title*="unsaved" i]');
      if (unsavedNode) dirtyHint = true;

      var fiberNode = container;
      var fiberKey = null;
      while (fiberNode && !fiberKey) {
        fiberKey = Object.keys(fiberNode).find(function(key) { return key.indexOf('__reactFiber$') === 0; });
        if (!fiberKey) fiberNode = fiberNode.parentElement;
      }
      var inspected = typeof WeakSet === 'function' ? new WeakSet() : null;
      var budget = 500;
      function inspect(value, path, depth) {
        if (!value || typeof value !== 'object' || depth > 4 || budget-- <= 0) return;
        if (inspected) {
          if (inspected.has(value)) return;
          inspected.add(value);
        }
        var keys;
        try { keys = Object.keys(value); } catch (_) { return; }
        for (var k = 0; k < keys.length; k++) {
          var key = keys[k];
          var child;
          try { child = value[key]; } catch (_) { continue; }
          var lower = key.toLowerCase();
          if (lower === 'scriptid' || lower === 'scriptidpart' || lower === 'pineid') {
            addCandidate(String(child || ''), 'react:' + path + '.' + key);
          }
          if (!visibleTitle && (lower === 'scriptname' || lower === 'scripttitle') && typeof child === 'string') {
            visibleTitle = child.trim() || null;
          }
          if ((lower === 'isdirty' || lower === 'dirty' || lower === 'hasunsavedchanges') && child === true) {
            dirtyHint = true;
          }
          if (child && typeof child === 'object') inspect(child, path + '.' + key, depth + 1);
        }
      }
      var fiber = fiberKey ? fiberNode[fiberKey] : null;
      for (var f = 0; fiber && f < 25; f++, fiber = fiber.return) {
        inspect(fiber.memoizedProps, 'fiber' + f + '.props', 0);
        inspect(fiber.memoizedState, 'fiber' + f + '.state', 0);
      }

      return {
        editor_visible: true,
        source: monaco.editor.getValue(),
        model_uri: model && model.uri ? String(model.uri) : null,
        visible_title: visibleTitle,
        dirty_hint: dirtyHint,
        binding_candidates: candidates
      };
    })()
  `);
}

async function readSavedSource({ scriptId, revision, _deps = {} }) {
  if (!scriptId || revision === null || revision === undefined) return undefined;
  const _evaluateAsync = _deps.evaluateAsync || evaluateAsync;
  const id = JSON.stringify(scriptId);
  const version = JSON.stringify(revision);
  const result = await _evaluateAsync(`
    (function() {
      var id = ${id};
      var revision = ${version};
      var url = 'https://pine-facade.tradingview.com/pine-facade/get/'
        + encodeURIComponent(id) + '/' + encodeURIComponent(String(revision));
      return fetch(url, { credentials: 'include' })
        .then(function(response) {
          if (!response.ok) throw new Error('pine-facade get returned HTTP ' + response.status);
          return response.json();
        })
        .then(function(data) { return { source: typeof data.source === 'string' ? data.source : null }; })
        .catch(function(error) { return { source: null, error: error.message }; });
    })()
  `);
  return typeof result?.source === 'string' ? result.source : undefined;
}

export async function getBoundIdentity({ _deps = {} } = {}) {
  const deps = dependencies(_deps);
  const ready = await deps.ensurePineEditorOpen();
  if (!ready) {
    return deriveBoundIdentity({ editorState: { editor_visible: false }, inventory: [] });
  }

  let inventory;
  try {
    inventory = await deps.listPersistentScripts({ _deps });
  } catch (error) {
    return {
      ...deriveBoundIdentity({ editorState: { editor_visible: true }, inventory: [] }),
      identity_reason: 'PERSISTENT_INVENTORY_UNAVAILABLE',
      error: error.message,
    };
  }
  const editorState = await deps.readEditorBindingState({ _deps });
  const preliminary = deriveBoundIdentity({ editorState, inventory });
  let savedSource;
  if (preliminary.bound_script_id) {
    savedSource = await deps.readSavedSource({
      scriptId: preliminary.bound_script_id,
      revision: preliminary.bound_revision,
      _deps,
    });
  }
  return deriveBoundIdentity({ editorState, inventory, savedSource });
}

async function preWriteIdentity(expectedScriptId, _deps = {}) {
  const deps = dependencies(_deps);
  const identity = await deps.getBoundIdentity({ _deps });
  const gate = evaluateWriteIdentity({
    identity,
    expectedScriptId,
    protectedIds: deps.protectedIds,
  });
  return { identity, gate };
}

function gateFailure(identity, gate) {
  return {
    success: false,
    reason: gate.reason,
    no_mutation: true,
    expected_script_id: gate.expected_script_id || null,
    actual_bound_script_id: gate.actual_bound_script_id || identity?.bound_script_id || null,
    identity_confidence: identity?.identity_confidence || 'UNPROVEN',
    buffer_state: identity?.buffer_state || 'UNKNOWN',
    unsaved_state: identity?.unsaved_state ?? null,
  };
}

async function openScriptViaUi({ name, scriptId, _deps = {} }) {
  const deps = dependencies(_deps);
  const openedMenu = await deps.evaluate(`
    (function() {
      var selectors = [
        '[data-name="open-script-button"]',
        '[data-name="pine-script-menu"]',
        '[data-name="script-title"]',
        '[data-name="pine-script-name"]'
      ];
      for (var i = 0; i < selectors.length; i++) {
        var element = document.querySelector(selectors[i]);
        if (element && element.offsetParent !== null) { element.click(); return selectors[i]; }
      }
      return null;
    })()
  `);
  if (!openedMenu) return false;
  await deps.sleep(250);
  const escapedName = JSON.stringify(name);
  const escapedId = JSON.stringify(scriptId);
  return deps.evaluate(`
    (function() {
      var targetName = ${escapedName};
      var targetId = ${escapedId};
      var elements = document.querySelectorAll('[role="menuitem"], [data-role="menuitem"], [class*="menuItem"], [class*="item"]');
      var nameMatch = null;
      for (var i = 0; i < elements.length; i++) {
        var element = elements[i];
        if (element.offsetParent === null) continue;
        var elementId = element.getAttribute('data-script-id') || element.getAttribute('data-id');
        if (elementId === targetId) { element.click(); return true; }
        if (!nameMatch && element.textContent.trim() === targetName) nameMatch = element;
      }
      if (nameMatch) { nameMatch.click(); return true; }
      return false;
    })()
  `);
}

async function createNewViaUi({ type, _deps = {} }) {
  const deps = dependencies(_deps);
  const menuOpened = await deps.evaluate(`
    (function() {
      var selectors = ['[data-name="new-script-button"]', '[data-name="pine-script-menu"]', '[data-name="script-title"]'];
      for (var i = 0; i < selectors.length; i++) {
        var element = document.querySelector(selectors[i]);
        if (element && element.offsetParent !== null) { element.click(); return true; }
      }
      return false;
    })()
  `);
  if (!menuOpened) return false;
  await deps.sleep(250);
  const label = JSON.stringify(type);
  return deps.evaluate(`
    (function() {
      var type = ${label};
      var pattern = type === 'strategy' ? /new strategy/i : type === 'library' ? /new library/i : /new indicator/i;
      var elements = document.querySelectorAll('[role="menuitem"], [data-role="menuitem"], [class*="menuItem"], [class*="item"]');
      for (var i = 0; i < elements.length; i++) {
        if (elements[i].offsetParent !== null && pattern.test(elements[i].textContent.trim())) {
          elements[i].click();
          return true;
        }
      }
      return false;
    })()
  `);
}

// ── Pure / offline functions ──

export function analyze({ source }) {
  const lines = source.split('\n');
  const diagnostics = [];

  let isV6 = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('//@version=6')) { isV6 = true; break; }
    if (trimmed.startsWith('//@version=')) break;
    if (trimmed === '' || trimmed.startsWith('//')) continue;
    break;
  }

  const arrays = new Map();
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fromMatch = line.match(/(\w+)\s*=\s*array\.from\(([^)]*)\)/);
    if (fromMatch) {
      const name = fromMatch[1].trim();
      const args = fromMatch[2].trim();
      const size = args === '' ? 0 : args.split(',').length;
      arrays.set(name, { name, size, line: i + 1 });
      continue;
    }
    const newMatch = line.match(/(\w+)\s*=\s*array\.new(?:<\w+>|_\w+)\((\d+)?/);
    if (newMatch) {
      const name = newMatch[1].trim();
      const size = newMatch[2] !== undefined ? parseInt(newMatch[2], 10) : null;
      arrays.set(name, { name, size, line: i + 1 });
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const pattern = /array\.(get|set)\(\s*(\w+)\s*,\s*(-?\d+)/g;
    let match;
    while ((match = pattern.exec(line)) !== null) {
      const method = match[1];
      const arrName = match[2];
      const idx = parseInt(match[3], 10);
      const info = arrays.get(arrName);
      if (!info || info.size === null) continue;
      if (idx < 0 || idx >= info.size) {
        diagnostics.push({
          line: i + 1, column: match.index + 1,
          message: `array.${method}(${arrName}, ${idx}) — index ${idx} out of bounds (array size is ${info.size})`,
          severity: 'error',
        });
      }
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const firstLastPattern = /(\w+)\.(first|last)\(\)/g;
    let match;
    while ((match = firstLastPattern.exec(line)) !== null) {
      const arrName = match[1];
      if (arrName === 'array') continue;
      const info = arrays.get(arrName);
      if (info && info.size === 0) {
        diagnostics.push({
          line: i + 1, column: match.index + 1,
          message: `${arrName}.${match[2]}() called on possibly empty array (declared with size 0)`,
          severity: 'warning',
        });
      }
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (trimmed.includes('strategy.entry') || trimmed.includes('strategy.close')) {
      let hasStrategyDecl = false;
      for (const l of lines) {
        if (l.trim().startsWith('strategy(')) { hasStrategyDecl = true; break; }
      }
      if (!hasStrategyDecl) {
        diagnostics.push({
          line: i + 1, column: 1,
          message: 'strategy.entry/close used but no strategy() declaration found — did you mean to use indicator()?',
          severity: 'error',
        });
        break;
      }
    }
  }

  if (!isV6 && source.includes('//@version=')) {
    const vMatch = source.match(/\/\/@version=(\d+)/);
    if (vMatch && parseInt(vMatch[1]) < 5) {
      diagnostics.push({
        line: 1, column: 1,
        message: `Script uses Pine v${vMatch[1]} — consider upgrading to v6 for latest features`,
        severity: 'info',
      });
    }
  }

  return {
    success: true,
    issue_count: diagnostics.length,
    diagnostics,
    note: diagnostics.length === 0 ? 'No static analysis issues found. Use pine_compile or pine_smart_compile for full server-side compilation check.' : undefined,
  };
}

export async function check({ source }) {
  const formData = new URLSearchParams();
  formData.append('source', source);

  const response = await fetch(
    'https://pine-facade.tradingview.com/pine-facade/translate_light?user_name=Guest&pine_id=00000000-0000-0000-0000-000000000000',
    {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
        'Referer': 'https://www.tradingview.com/',
      },
      body: formData,
    }
  );

  if (!response.ok) {
    throw new Error(`TradingView API returned ${response.status}: ${response.statusText}`);
  }

  const result = await response.json();
  const errors = [];
  const warnings = [];
  const inner = result?.result;

  if (inner) {
    if (inner.errors2 && inner.errors2.length > 0) {
      for (const e of inner.errors2) {
        errors.push({
          line: e.start?.line, column: e.start?.column,
          end_line: e.end?.line, end_column: e.end?.column,
          message: e.message,
        });
      }
    }
    if (inner.warnings2 && inner.warnings2.length > 0) {
      for (const w of inner.warnings2) {
        warnings.push({ line: w.start?.line, column: w.start?.column, message: w.message });
      }
    }
  }

  if (result.error && typeof result.error === 'string') {
    errors.push({ message: result.error });
  }

  const compiled = errors.length === 0;
  return {
    success: true,
    compiled,
    error_count: errors.length,
    warning_count: warnings.length,
    errors: errors.length > 0 ? errors : undefined,
    warnings: warnings.length > 0 ? warnings : undefined,
    note: compiled ? 'Pine Script compiled successfully.' : undefined,
  };
}

// ── Functions requiring TradingView connection ──

export async function getSource() {
  const editorReady = await ensurePineEditorOpen();
  if (!editorReady) throw new Error('Could not open Pine Editor or Monaco not found in React fiber tree.');

  const source = await evaluate(`
    (function() {
      var m = ${FIND_MONACO};
      if (!m) return null;
      return m.editor.getValue();
    })()
  `);

  if (source === null || source === undefined) {
    throw new Error('Monaco editor found but getValue() returned null.');
  }

  return { success: true, source, line_count: source.split('\n').length, char_count: source.length };
}

export async function setSource({ source, expected_script_id, _deps = {} }) {
  const deps = dependencies(_deps);
  const editorReady = await deps.ensurePineEditorOpen();
  if (!editorReady) throw new Error('Could not open Pine Editor.');

  const { identity, gate } = await preWriteIdentity(expected_script_id, _deps);
  if (!gate.ok) return gateFailure(identity, gate);

  const escaped = JSON.stringify(source);
  const set = await deps.evaluate(`
    (function() {
      var m = ${FIND_MONACO};
      if (!m) return false;
      m.editor.setValue(${escaped});
      return true;
    })()
  `);

  if (!set) throw new Error('Monaco found but setValue() failed.');
  return {
    success: true,
    lines_set: source.split('\n').length,
    script_id: gate.actual_bound_script_id,
    identity_guard: 'PASSED',
  };
}

export async function compile({ expected_script_id, _deps = {} } = {}) {
  const deps = dependencies(_deps);
  const editorReady = await deps.ensurePineEditorOpen();
  if (!editorReady) throw new Error('Could not open Pine Editor.');

  const { identity, gate } = await preWriteIdentity(expected_script_id, _deps);
  if (!gate.ok) return gateFailure(identity, gate);

  const clicked = await deps.evaluate(`
    (function() {
      var btns = document.querySelectorAll('button');
      var fallback = null;
      var saveBtn = null;
      for (var i = 0; i < btns.length; i++) {
        var text = btns[i].textContent.trim();
        if (/save and add to chart/i.test(text)) {
          btns[i].click();
          return 'Save and add to chart';
        }
        if (!fallback && /^(Add to chart|Update on chart)/i.test(text)) {
          fallback = btns[i];
        }
        if (!saveBtn && btns[i].className.indexOf('saveButton') !== -1 && btns[i].offsetParent !== null) {
          saveBtn = btns[i];
        }
      }
      if (fallback) { fallback.click(); return fallback.textContent.trim(); }
      if (saveBtn) { saveBtn.click(); return 'Pine Save'; }
      return null;
    })()
  `);

  if (!clicked) {
    const c = await deps.getClient();
    await c.Input.dispatchKeyEvent({ type: 'keyDown', modifiers: 2, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await c.Input.dispatchKeyEvent({ type: 'keyUp', key: 'Enter', code: 'Enter' });
  }

  await deps.sleep(2000);
  return {
    success: true,
    button_clicked: clicked || 'keyboard_shortcut',
    source: 'dom_fallback',
    script_id: gate.actual_bound_script_id,
    identity_guard: 'PASSED',
  };
}

export async function getErrors() {
  const editorReady = await ensurePineEditorOpen();
  if (!editorReady) throw new Error('Could not open Pine Editor.');

  const errors = await evaluate(`
    (function() {
      var m = ${FIND_MONACO};
      if (!m) return [];
      var model = m.editor.getModel();
      if (!model) return [];
      var markers = m.env.editor.getModelMarkers({ resource: model.uri });
      return markers.map(function(mk) {
        return { line: mk.startLineNumber, column: mk.startColumn, message: mk.message, severity: mk.severity };
      });
    })()
  `);

  return {
    success: true,
    has_errors: errors?.length > 0,
    error_count: errors?.length || 0,
    errors: errors || [],
  };
}

export async function save({ expected_script_id, _deps = {} } = {}) {
  const deps = dependencies(_deps);
  const editorReady = await deps.ensurePineEditorOpen();
  if (!editorReady) throw new Error('Could not open Pine Editor.');

  let checked = await preWriteIdentity(expected_script_id, _deps);
  if (!checked.gate.ok) return gateFailure(checked.identity, checked.gate);

  const c = await deps.getClient();
  await c.Input.dispatchKeyEvent({ type: 'keyDown', modifiers: 2, key: 's', code: 'KeyS', windowsVirtualKeyCode: 83 });
  await c.Input.dispatchKeyEvent({ type: 'keyUp', key: 's', code: 'KeyS' });
  await deps.sleep(800);

  // Handle "Save Script" name dialog that appears for new/unsaved scripts
  const dialogPresent = await deps.evaluate(`
    (function() {
      var btns = document.querySelectorAll('button');
      for (var i = 0; i < btns.length; i++) {
        var text = btns[i].textContent.trim();
        if (text === 'Save' && btns[i].offsetParent !== null) {
          // Check if it's in a dialog (not the Pine Editor save button)
          var parent = btns[i].closest('[class*="dialog"], [class*="modal"], [class*="popup"], [role="dialog"]');
          if (parent) return true;
        }
      }
      return false;
    })()
  `);

  let dialogHandled = false;
  if (dialogPresent) {
    checked = await preWriteIdentity(expected_script_id, _deps);
    if (!checked.gate.ok) return gateFailure(checked.identity, checked.gate);
    dialogHandled = await deps.evaluate(`
      (function() {
        var btns = document.querySelectorAll('button');
        for (var i = 0; i < btns.length; i++) {
          var text = btns[i].textContent.trim();
          var parent = btns[i].closest('[class*="dialog"], [class*="modal"], [class*="popup"], [role="dialog"]');
          if (text === 'Save' && btns[i].offsetParent !== null && parent) { btns[i].click(); return true; }
        }
        return false;
      })()
    `);
    if (dialogHandled) await deps.sleep(500);
  }

  return {
    success: true,
    action: dialogHandled ? 'saved_with_dialog' : 'Ctrl+S_dispatched',
    script_id: checked.gate.actual_bound_script_id,
    identity_guard: 'PASSED',
  };
}

export async function getConsole() {
  const editorReady = await ensurePineEditorOpen();
  if (!editorReady) throw new Error('Could not open Pine Editor.');

  const entries = await evaluate(`
    (function() {
      var results = [];
      var rows = document.querySelectorAll('[class*="consoleRow"], [class*="log-"], [class*="consoleLine"]');
      if (rows.length === 0) {
        var bottomArea = document.querySelector('[class*="layout__area--bottom"]')
          || document.querySelector('[class*="bottom-widgetbar-content"]');
        if (bottomArea) {
          rows = bottomArea.querySelectorAll('[class*="message"], [class*="log"], [class*="console"]');
        }
      }
      if (rows.length === 0) {
        var pinePanel = document.querySelector('.pine-editor-container')
          || document.querySelector('[class*="pine-editor"]')
          || document.querySelector('[class*="layout__area--bottom"]');
        if (pinePanel) {
          var allSpans = pinePanel.querySelectorAll('span, div');
          for (var s = 0; s < allSpans.length; s++) {
            var txt = allSpans[s].textContent.trim();
            if (/^\\d{2}:\\d{2}:\\d{2}/.test(txt) || /error|warning|info/i.test(allSpans[s].className)) {
              rows = Array.from(rows || []);
              rows.push(allSpans[s]);
            }
          }
        }
      }
      for (var i = 0; i < rows.length; i++) {
        var text = rows[i].textContent.trim();
        if (!text) continue;
        var ts = null;
        var tsMatch = text.match(/^(\\d{4}-\\d{2}-\\d{2}\\s+)?\\d{2}:\\d{2}:\\d{2}/);
        if (tsMatch) ts = tsMatch[0];
        var type = 'info';
        var cls = rows[i].className || '';
        if (/error/i.test(cls) || /error/i.test(text.substring(0, 30))) type = 'error';
        else if (/compil/i.test(text.substring(0, 40))) type = 'compile';
        else if (/warn/i.test(cls)) type = 'warning';
        results.push({ timestamp: ts, type: type, message: text });
      }
      return results;
    })()
  `);

  return { success: true, entries: entries || [], entry_count: entries?.length || 0 };
}

export async function smartCompile({ expected_script_id, _deps = {} } = {}) {
  const deps = dependencies(_deps);
  const editorReady = await deps.ensurePineEditorOpen();
  if (!editorReady) throw new Error('Could not open Pine Editor.');

  const studiesBefore = await deps.evaluate(`
    (function() {
      try {
        var chart = window.TradingViewApi._activeChartWidgetWV.value();
        if (chart && typeof chart.getAllStudies === 'function') return chart.getAllStudies().length;
      } catch(e) {}
      return null;
    })()
  `);

  const { identity, gate } = await preWriteIdentity(expected_script_id, _deps);
  if (!gate.ok) return gateFailure(identity, gate);

  const buttonClicked = await deps.evaluate(`
    (function() {
      var btns = document.querySelectorAll('button');
      var addBtn = null;
      var updateBtn = null;
      var saveBtn = null;
      for (var i = 0; i < btns.length; i++) {
        var text = btns[i].textContent.trim();
        if (/save and add to chart/i.test(text)) {
          btns[i].click();
          return 'Save and add to chart';
        }
        if (!addBtn && /^add to chart$/i.test(text)) addBtn = btns[i];
        if (!updateBtn && /^update on chart$/i.test(text)) updateBtn = btns[i];
        if (!saveBtn && btns[i].className.indexOf('saveButton') !== -1 && btns[i].offsetParent !== null) saveBtn = btns[i];
      }
      if (addBtn) { addBtn.click(); return 'Add to chart'; }
      if (updateBtn) { updateBtn.click(); return 'Update on chart'; }
      if (saveBtn) { saveBtn.click(); return 'Pine Save'; }
      return null;
    })()
  `);

  if (!buttonClicked) {
    const c = await deps.getClient();
    await c.Input.dispatchKeyEvent({ type: 'keyDown', modifiers: 2, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await c.Input.dispatchKeyEvent({ type: 'keyUp', key: 'Enter', code: 'Enter' });
  }

  await deps.sleep(2500);

  const errors = await deps.evaluate(`
    (function() {
      var m = ${FIND_MONACO};
      if (!m) return [];
      var model = m.editor.getModel();
      if (!model) return [];
      var markers = m.env.editor.getModelMarkers({ resource: model.uri });
      return markers.map(function(mk) {
        return { line: mk.startLineNumber, column: mk.startColumn, message: mk.message, severity: mk.severity };
      });
    })()
  `);

  const studiesAfter = await deps.evaluate(`
    (function() {
      try {
        var chart = window.TradingViewApi._activeChartWidgetWV.value();
        if (chart && typeof chart.getAllStudies === 'function') return chart.getAllStudies().length;
      } catch(e) {}
      return null;
    })()
  `);

  const studyAdded = (studiesBefore !== null && studiesAfter !== null) ? studiesAfter > studiesBefore : null;

  return {
    success: true,
    button_clicked: buttonClicked || 'keyboard_shortcut',
    has_errors: errors?.length > 0,
    errors: errors || [],
    study_added: studyAdded,
    script_id: gate.actual_bound_script_id,
    identity_guard: 'PASSED',
  };
}

export async function newScript({ type, expected_script_id, _deps = {} }) {
  const deps = dependencies(_deps);
  const editorReady = await deps.ensurePineEditorOpen();
  if (!editorReady) throw new Error('Could not open Pine Editor.');

  const before = await deps.listPersistentScripts({ _deps });
  const previous = await deps.getBoundIdentity({ _deps });
  const gate = evaluateWriteIdentity({
    identity: previous,
    expectedScriptId: expected_script_id,
    protectedIds: deps.protectedIds,
  });
  if (!gate.ok) return gateFailure(previous, gate);

  const actionCompleted = await deps.createNewViaUi({ type, _deps });
  if (!actionCompleted) {
    return { success: false, reason: 'NEW_UI_ACTION_FAILED', no_mutation: true };
  }
  await deps.sleep(400);

  const after = await deps.listPersistentScripts({ _deps });
  const addedIds = addedPersistentScriptIds(before, after);
  const actual = await deps.getBoundIdentity({ _deps });
  if (addedIds.length === 1
      && addedIds[0] !== previous.bound_script_id
      && actual.identity_confidence === 'PROVEN'
      && actual.bound_script_id === addedIds[0]) {
    return {
      success: true,
      type,
      action: 'new_persistent_script_created',
      previous_script_id: previous.bound_script_id,
      new_script_id: addedIds[0],
      inventory_proof: 'PASSED',
    };
  }

  const transient = addedIds.length === 0;
  return {
    success: false,
    reason: transient ? 'TRANSIENT_UNBOUND_BUFFER' : 'NEW_IDENTITY_NOT_PROVEN',
    state: transient ? 'TRANSIENT_UNBOUND_BUFFER' : 'BINDING_NOT_PROVEN',
    previous_script_id: previous.bound_script_id,
    actual_bound_script_id: actual.bound_script_id,
    new_persistent_ids: addedIds,
    identity_confidence: actual.identity_confidence,
    writes_requiring_persistent_identity_prohibited: true,
  };
}

export async function openScript({ name, script_id, expected_script_id, _deps = {} }) {
  const deps = dependencies(_deps);
  const editorReady = await deps.ensurePineEditorOpen();
  if (!editorReady) throw new Error('Could not open Pine Editor.');

  const inventory = await deps.listPersistentScripts({ _deps });
  const resolved = resolveRequestedScript({ inventory, scriptId: script_id, name });
  if (!resolved.success) return { success: false, reason: resolved.reason, ...resolved };

  const current = await deps.getBoundIdentity({ _deps });
  const gate = evaluateWriteIdentity({
    identity: current,
    expectedScriptId: expected_script_id,
    protectedIds: deps.protectedIds,
  });
  if (!gate.ok) return gateFailure(current, gate);

  const requestedId = resolved.resolved_script_id;
  const requestedName = resolved.script.name || resolved.script.title;
  const navigated = await deps.openScriptViaUi({ name: requestedName, scriptId: requestedId, _deps });
  if (!navigated) {
    return { success: false, reason: 'OPEN_UI_NAVIGATION_FAILED', requested_script_id: requestedId };
  }

  let actual = null;
  for (let attempt = 0; attempt < deps.postconditionAttempts; attempt++) {
    await deps.sleep(attempt === 0 ? 250 : 200);
    actual = await deps.getBoundIdentity({ _deps });
    if (actual.identity_confidence === 'PROVEN'
        && actual.bound_script_id === requestedId
        && actual.unsaved_state === false) {
      return {
        success: true,
        opened: true,
        name: actual.bound_script_name,
        script_id: actual.bound_script_id,
        revision: actual.bound_revision,
        buffer_state: actual.buffer_state,
        identity_confidence: actual.identity_confidence,
      };
    }
  }

  return {
    success: false,
    reason: 'BINDING_NOT_PROVEN',
    requested_script_id: requestedId,
    actual_bound_script_id: actual?.bound_script_id || null,
    identity_confidence: actual?.identity_confidence || 'UNPROVEN',
    buffer_state: actual?.buffer_state || 'UNKNOWN',
    unsaved_state: actual?.unsaved_state ?? null,
  };
}

export async function listScripts({ _deps = {} } = {}) {
  const deps = dependencies(_deps);
  const scripts = await deps.listPersistentScripts({ _deps });
  return {
    success: true,
    scripts,
    count: scripts.length,
    source: 'internal_api',
  };
}
