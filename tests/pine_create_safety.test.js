/**
 * Offline tests for genuine new-Strategy creation decisions.
 *
 * The real menu on the build under test reads:
 *
 *   "Indikator⌘ K, ⌘ I"   aria="Indikator"
 *   "Strategie⌘ K, ⌘ S"   aria="Strategie"
 *   "Bibliothek"          aria="Bibliothek"
 *
 * so English label matching from upstream PR #415 would have failed here. These tests
 * pin the locale-neutral selection, the known-label fallback, and the refusal to guess.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';

import {
  DECLARATION,
  TYPE_LABELS,
  matchesAccelerator,
  selectTypeMenuItem,
  selectSubmenuParent,
  provesDeclaration,
  firstSaveVerdict,
  looksLikeUnsavedPrompt,
  selectDiscardButton,
  NEVER_CLICK_LABELS,
} from '../src/core/pine_create.js';

/** Verbatim from the live German build. */
const GERMAN_SUBMENU = [
  { text: 'Skript speichern⌘ S', aria: 'Skript speichern' },
  { text: 'Kopie erstellen…', aria: 'Kopie erstellen…' },
  { text: 'Umbenennen…', aria: 'Umbenennen…' },
  { text: 'Versionshistorie…', aria: 'Versionshistorie…' },
  { text: 'Script ans Ende setzen', aria: 'Script ans Ende setzen' },
  { text: 'Neu erstellen', aria: '', haspopup: 'menu' },
  { text: 'Skript öffnen…⌘ O', aria: 'Skript öffnen…' },
  { text: 'Indikator⌘ K, ⌘ I', aria: 'Indikator' },
  { text: 'Strategie⌘ K, ⌘ S', aria: 'Strategie' },
  { text: 'Bibliothek', aria: 'Bibliothek' },
  { text: 'Eingebaut…', aria: 'Eingebaut…' },
];

const ENGLISH_SUBMENU = [
  { text: 'Save script⌘ S', aria: 'Save script' },
  { text: 'Create new', aria: '', haspopup: 'menu' },
  { text: 'Indicator⌘ K, ⌘ I', aria: 'Indicator' },
  { text: 'Strategy⌘ K, ⌘ S', aria: 'Strategy' },
  { text: 'Library', aria: 'Library' },
];

describe('the accelerator is the locale-neutral signal', () => {
  it('picks Strategy by its K,S chord on a German build', () => {
    const r = selectTypeMenuItem(GERMAN_SUBMENU, 'strategy');
    assert.ok(r.ok, r.reason);
    assert.equal(GERMAN_SUBMENU[r.index].aria, 'Strategie');
    assert.equal(r.by, 'ACCELERATOR');
  });

  it('picks Strategy on an English build the same way', () => {
    const r = selectTypeMenuItem(ENGLISH_SUBMENU, 'strategy');
    assert.ok(r.ok);
    assert.equal(ENGLISH_SUBMENU[r.index].aria, 'Strategy');
    assert.equal(r.by, 'ACCELERATOR');
  });

  it('does not confuse Indicator with Strategy', () => {
    const r = selectTypeMenuItem(GERMAN_SUBMENU, 'indicator');
    assert.ok(r.ok);
    assert.equal(GERMAN_SUBMENU[r.index].aria, 'Indikator');
  });

  it('is not fooled by the Save-script accelerator, which is a bare S', () => {
    // "Skript speichern⌘ S" has an S chord but no preceding K chord.
    assert.equal(matchesAccelerator('Skript speichern⌘ S', 'strategy'), false);
    assert.equal(matchesAccelerator('Strategie⌘ K, ⌘ S', 'strategy'), true);
  });

  it('is not fooled by the Open-script accelerator', () => {
    assert.equal(matchesAccelerator('Skript öffnen…⌘ O', 'strategy'), false);
    assert.equal(matchesAccelerator('Skript öffnen…⌘ O', 'indicator'), false);
  });

  it('accepts a Ctrl-style accelerator for non-mac builds', () => {
    assert.equal(matchesAccelerator('Strategy Ctrl+K, Ctrl+S', 'strategy'), true);
    assert.equal(matchesAccelerator('Indicator Ctrl+K, Ctrl+I', 'indicator'), true);
    assert.equal(matchesAccelerator('Strategy Ctrl+K, Ctrl+S', 'indicator'), false);
  });
});

describe('the label fallback is exact, and unknown locales fail closed', () => {
  it('falls back to a known label when no accelerator is shown', () => {
    const noAccel = [{ text: 'Strategie', aria: 'Strategie' }];
    const r = selectTypeMenuItem(noAccel, 'strategy');
    assert.ok(r.ok);
    assert.equal(r.by, 'KNOWN_LABEL');
  });

  it('refuses an unknown locale rather than guessing', () => {
    const japanese = [
      { text: 'インジケーター', aria: 'インジケーター' },
      { text: 'ストラテジー', aria: 'ストラテジー' },
    ];
    const r = selectTypeMenuItem(japanese, 'strategy');
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'NO_LOCALE_NEUTRAL_MATCH');
    assert.ok(r.candidates.length > 0, 'must report what it saw so the locale can be added');
  });

  it('never selects by position', () => {
    // Exactly the shape where a positional heuristic would "work" and be wrong.
    const reordered = [
      { text: 'Bibliothek', aria: 'Bibliothek' },
      { text: 'Etwas anderes', aria: 'Etwas anderes' },
    ];
    assert.equal(selectTypeMenuItem(reordered, 'strategy').ok, false);
  });

  it('refuses an ambiguous label match', () => {
    const dup = [
      { text: 'Strategie', aria: 'Strategie' },
      { text: 'Strategy', aria: 'Strategy' },
    ];
    const r = selectTypeMenuItem(dup, 'strategy');
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'AMBIGUOUS_LABEL');
  });

  it('rejects an unsupported type outright', () => {
    assert.equal(selectTypeMenuItem(GERMAN_SUBMENU, 'wat').reason, 'UNSUPPORTED_TYPE');
  });
});

describe('the submenu parent is found structurally, not by text', () => {
  it('finds the aria-haspopup entry on a German build', () => {
    const r = selectSubmenuParent(GERMAN_SUBMENU);
    assert.ok(r.ok, r.reason);
    assert.equal(GERMAN_SUBMENU[r.index].text, 'Neu erstellen');
  });

  it('fails closed when no entry owns a popup', () => {
    const r = selectSubmenuParent(GERMAN_SUBMENU.map(({ haspopup, ...rest }) => rest));
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'NO_SUBMENU_PARENT');
  });

  it('fails closed when several entries own popups', () => {
    const two = [...GERMAN_SUBMENU, { text: 'Anderes', aria: '', haspopup: 'menu' }];
    const r = selectSubmenuParent(two);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'AMBIGUOUS_SUBMENU_PARENT');
  });
});

describe('the created buffer must prove its own type', () => {
  it('accepts a strategy declaration', () => {
    assert.ok(provesDeclaration('//@version=6\nstrategy("x")\n', 'strategy'));
  });

  it('rejects an indicator buffer when a strategy was requested', () => {
    assert.equal(provesDeclaration('//@version=6\nindicator("x")\n', 'strategy'), false);
  });

  it('rejects an empty or unrelated buffer', () => {
    for (const s of ['', null, undefined, '// nothing here']) {
      assert.equal(provesDeclaration(s, 'strategy'), false);
    }
  });

  it('has a declaration pattern for every supported type', () => {
    assert.deepEqual(Object.keys(DECLARATION).sort(), Object.keys(TYPE_LABELS).sort());
  });
});

describe('the first save is judged on all seven conditions together', () => {
  const NEW = 'USER;newly0000created0000000000000';
  const SANDBOX = 'USER;c4142bc6e1994d919dd8fac7ac6b5fce';
  const FORWARD = 'USER;a30dc62e926b41338001d5b7357c6658';
  const base = {
    serverPersistenceVerified: true,
    facadeExactNameMatches: 1,
    inventoryBeforeIds: [SANDBOX, FORWARD],
    inventoryAfterIds: [SANDBOX, FORWARD, NEW],
    newId: NEW,
    sandboxId: SANDBOX,
    forwardId: FORWARD,
    editorSource: '//@version=6\nstrategy("x")\n',
    savedSource: '//@version=6\nstrategy("x")\n',
  };

  it('passes when everything holds', () => {
    const r = firstSaveVerdict(base);
    assert.ok(r.ok, JSON.stringify(r.problems));
    assert.deepEqual(r.inventoryDelta, [NEW]);
  });

  it('tolerates a CRLF/LF difference between editor and saved source', () => {
    const r = firstSaveVerdict({ ...base, savedSource: '//@version=6\r\nstrategy("x")\r\n' });
    assert.ok(r.ok, JSON.stringify(r.problems));
  });

  it('fails without server persistence verification', () => {
    const r = firstSaveVerdict({ ...base, serverPersistenceVerified: false });
    assert.equal(r.ok, false);
    assert.ok(r.problems.includes('SERVER_PERSISTENCE_NOT_VERIFIED'));
  });

  it('fails when the name is not uniquely resolvable on the server', () => {
    for (const n of [0, 2]) {
      const r = firstSaveVerdict({ ...base, facadeExactNameMatches: n });
      assert.equal(r.ok, false);
      assert.ok(r.problems.some(p => p.startsWith('FACADE_NAME_MATCH_')));
    }
  });

  it('fails when the inventory delta is not exactly one', () => {
    const none = firstSaveVerdict({ ...base, inventoryAfterIds: [SANDBOX, FORWARD] });
    assert.ok(none.problems.includes('INVENTORY_DELTA_0'));
    const two = firstSaveVerdict({
      ...base, inventoryAfterIds: [SANDBOX, FORWARD, NEW, 'USER;extra'],
    });
    assert.ok(two.problems.includes('INVENTORY_DELTA_2'));
  });

  it('fails when the reported new id is not the one that appeared', () => {
    const r = firstSaveVerdict({ ...base, newId: 'USER;somethingelse' });
    assert.equal(r.ok, false);
    assert.ok(r.problems.includes('NEW_ID_NOT_THE_DELTA'));
  });

  it('refuses to call a pre-existing script new', () => {
    const r = firstSaveVerdict({
      ...base, inventoryBeforeIds: [SANDBOX, FORWARD, NEW],
      inventoryAfterIds: [SANDBOX, FORWARD, NEW],
    });
    assert.equal(r.ok, false);
    assert.ok(r.problems.includes('NEW_ID_EXISTED_BEFORE'));
  });

  it('refuses if the new id is the sandbox or the protected Forward script', () => {
    const asSandbox = firstSaveVerdict({
      ...base, newId: SANDBOX, inventoryBeforeIds: [FORWARD],
      inventoryAfterIds: [FORWARD, SANDBOX],
    });
    assert.ok(asSandbox.problems.includes('NEW_ID_IS_THE_SANDBOX'));
    const asForward = firstSaveVerdict({
      ...base, newId: FORWARD, inventoryBeforeIds: [SANDBOX],
      inventoryAfterIds: [SANDBOX, FORWARD],
    });
    assert.ok(asForward.problems.includes('NEW_ID_IS_THE_FORWARD_SCRIPT'));
  });

  it('fails when what was saved is not what the editor held', () => {
    const r = firstSaveVerdict({ ...base, savedSource: '//@version=6\nstrategy("different")\n' });
    assert.equal(r.ok, false);
    assert.ok(r.problems.includes('SAVED_SOURCE_DIFFERS_FROM_EDITOR'));
  });

  it('reports every failed condition, not just the first', () => {
    const r = firstSaveVerdict({
      ...base, serverPersistenceVerified: false, facadeExactNameMatches: 3,
      savedSource: 'different',
    });
    assert.equal(r.ok, false);
    assert.ok(r.problems.length >= 3, JSON.stringify(r.problems));
  });
});


describe('the unsaved-changes prompt: never click save', () => {
  const GERMAN = ['Speichern', 'Nicht speichern', 'Abbrechen'];
  const ENGLISH = ['Save', "Don't save", 'Cancel'];
  // what the editor status bar looks like -- several buttons, mostly unlabelled
  const STATUS_BAR = ['', '', '', '', 'Nicht gespeicherte Version', 'Linie 1, Col 1'];

  it('recognises the real prompt in German and English', () => {
    assert.ok(looksLikeUnsavedPrompt(GERMAN));
    assert.ok(looksLikeUnsavedPrompt(ENGLISH));
  });

  it('does not mistake the editor status bar for the prompt', () => {
    assert.equal(looksLikeUnsavedPrompt(STATUS_BAR), false);
    // "Nicht gespeicherte Version" is a status label, not the discard button
    assert.equal(selectDiscardButton(STATUS_BAR).ok, false);
  });

  it('picks the discard button, not the save button', () => {
    const g = selectDiscardButton(GERMAN);
    assert.ok(g.ok, g.reason);
    assert.equal(GERMAN[g.index], 'Nicht speichern');
    assert.ok(g.neverClick.includes(0), 'the save button must be reported as never-click');

    const e = selectDiscardButton(ENGLISH);
    assert.ok(e.ok);
    assert.equal(ENGLISH[e.index], "Don't save");
  });

  it('never returns an index whose label is a save label', () => {
    for (const labels of [GERMAN, ENGLISH, ['Speichern'], ['Save', 'Cancel']]) {
      const r = selectDiscardButton(labels);
      if (r.ok) {
        assert.ok(!NEVER_CLICK_LABELS.some(s => s.toLowerCase() === String(labels[r.index]).toLowerCase()),
          `would have clicked ${labels[r.index]}`);
      }
    }
  });

  it('fails closed on an unknown locale rather than guessing', () => {
    const japanese = ['保存', '保存しない', 'キャンセル'];
    const r = selectDiscardButton(japanese);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'NO_KNOWN_DISCARD_LABEL');
    assert.ok(r.saw.length > 0);
  });

  it('fails closed when only a save option is offered', () => {
    const r = selectDiscardButton(['Speichern', 'Abbrechen']);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'NO_KNOWN_DISCARD_LABEL');
  });

  it('fails closed on duplicate discard labels', () => {
    const r = selectDiscardButton(['Nicht speichern', 'Nicht speichern', 'Speichern']);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'AMBIGUOUS_DISCARD_LABEL');
  });
});
