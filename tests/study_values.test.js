/**
 * Unit tests for buildStudyResults() (data_get_study_values extraction logic).
 * Pure unit (no CDP, no TradingView Desktop required).
 *
 * Covers the TradingView Desktop 3.3.0 regression where source.metaInfo()
 * throws/returns nothing for otherwise-valid studies (only `_studyMetaInfo`
 * carries description/id/inputs) — see getStudyValues() in src/core/data.js.
 *
 * Run: node --test tests/study_values.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildStudyResults } from '../src/core/data.js';

// A dataWindowView item using TradingView's internal _title/_value shape.
const dwItem = (title, value) => ({ _title: title, _value: value });

describe('buildStudyResults() — legacy metaInfo() + dataWindowView() path', () => {
  it('reads name/values via metaInfo() and dataWindowView().items() (unchanged)', () => {
    const source = {
      metaInfo: () => ({ description: 'Relative Strength Index', shortDescription: 'RSI' }),
      dataWindowView: () => ({ items: () => [dwItem('RSI', 55.2)] }),
      id: () => 'study_1',
      inputs: () => ({ length: 14 }),
    };
    const results = buildStudyResults([source]);
    assert.deepEqual(results, [
      { id: 'study_1', name: 'Relative Strength Index', inputs: { length: 14 }, values: { RSI: 55.2 } },
    ]);
  });

  it('falls back to shortDescription when description is missing', () => {
    const source = {
      metaInfo: () => ({ shortDescription: 'MACD' }),
      dataWindowView: () => ({ items: () => [dwItem('Histogram', 1.1)] }),
    };
    const results = buildStudyResults([source]);
    assert.equal(results[0].name, 'MACD');
  });

  it('excludes items with the "∅" sentinel or missing title/value', () => {
    const source = {
      metaInfo: () => ({ description: 'Bollinger Bands' }),
      dataWindowView: () => ({
        items: () => [dwItem('Upper', '∅'), dwItem('', 5), dwItem('Lower', 100)],
      }),
    };
    const results = buildStudyResults([source]);
    assert.deepEqual(results[0].values, { Lower: 100 });
  });
});

describe('buildStudyResults() — _studyMetaInfo fallback (TradingView 3.3.0)', () => {
  it('uses _studyMetaInfo when metaInfo() throws', () => {
    const source = {
      metaInfo: () => { throw new Error('not usable in this runtime'); },
      _studyMetaInfo: { description: 'Moving Average Convergence Divergence' },
      dataWindowView: () => ({ items: () => [dwItem('MACD', 0.42)] }),
      id: () => '51L80P',
    };
    const results = buildStudyResults([source]);
    assert.equal(results.length, 1);
    assert.equal(results[0].id, '51L80P');
    assert.equal(results[0].name, 'Moving Average Convergence Divergence');
    assert.deepEqual(results[0].values, { MACD: 0.42 });
  });

  it('uses _studyMetaInfo when metaInfo() returns an empty object', () => {
    const source = {
      metaInfo: () => ({}),
      _studyMetaInfo: { shortDescription: 'RSI' },
      dataWindowView: () => ({ items: () => [dwItem('RSI', 61)] }),
    };
    const results = buildStudyResults([source]);
    assert.equal(results[0].name, 'RSI');
  });

  it('supports _studyMetaInfo as a function, not just a plain property', () => {
    const source = {
      metaInfo: () => null,
      _studyMetaInfo: () => ({ description: 'Volume' }),
      dataWindowView: () => ({ items: () => [dwItem('Volume', 12345)] }),
    };
    const results = buildStudyResults([source]);
    assert.equal(results[0].name, 'Volume');
  });

  it('does not touch _studyMetaInfo when metaInfo() already succeeds', () => {
    let fallbackTouched = false;
    const source = {
      metaInfo: () => ({ description: 'EMA' }),
      get _studyMetaInfo() { fallbackTouched = true; return { description: 'should not be used' }; },
      dataWindowView: () => ({ items: () => [dwItem('EMA', 1)] }),
    };
    buildStudyResults([source]);
    assert.equal(fallbackTouched, false);
  });
});

describe('buildStudyResults() — sources without usable study metadata are excluded', () => {
  it('excludes a source with no metaInfo() and no _studyMetaInfo', () => {
    const source = { dataWindowView: () => ({ items: () => [dwItem('X', 1)] }) };
    assert.deepEqual(buildStudyResults([source]), []);
  });

  it('excludes a source where both metaInfo() and _studyMetaInfo lack a name', () => {
    const source = {
      metaInfo: () => ({}),
      _studyMetaInfo: {},
      dataWindowView: () => ({ items: () => [dwItem('X', 1)] }),
    };
    assert.deepEqual(buildStudyResults([source]), []);
  });

  it('excludes a source that has metadata but yields no readable values', () => {
    const source = {
      metaInfo: () => ({ description: 'Empty Study' }),
      dataWindowView: () => ({ items: () => [] }),
    };
    assert.deepEqual(buildStudyResults([source]), []);
  });
});

describe('buildStudyResults() — fallback value providers', () => {
  it('uses valuesProvider() when dataWindowView() yields nothing', () => {
    const source = {
      metaInfo: () => ({ description: 'Custom Study' }),
      dataWindowView: () => ({ items: () => [] }),
      valuesProvider: () => [{ title: 'Plot 0', value: 3.14 }],
    };
    const results = buildStudyResults([source]);
    assert.deepEqual(results[0].values, { 'Plot 0': 3.14 });
  });

  it('unwraps a WatchedValue-style valuesProvider (object with .value())', () => {
    const source = {
      metaInfo: () => ({ description: 'Custom Study' }),
      dataWindowView: () => ({ items: () => [] }),
      valuesProvider: { value: () => [{ title: 'Plot 0', value: 7 }] },
    };
    const results = buildStudyResults([source]);
    assert.deepEqual(results[0].values, { 'Plot 0': 7 });
  });

  it('falls back to legendValuesProvider when valuesProvider is unusable', () => {
    const source = {
      metaInfo: () => ({ description: 'Custom Study' }),
      dataWindowView: () => ({ items: () => [] }),
      valuesProvider: () => ({ not: 'a recognized shape' }),
      legendValuesProvider: () => [{ _title: 'Legend Plot', _value: 9 }],
    };
    const results = buildStudyResults([source]);
    assert.deepEqual(results[0].values, { 'Legend Plot': 9 });
  });

  it('skips a provider whose resolved shape is not a recognized items list (no guessing)', () => {
    const source = {
      metaInfo: () => ({ description: 'Custom Study' }),
      dataWindowView: () => ({ items: () => [] }),
      valuesProvider: () => 42,
      legendValuesProvider: () => ({ random: 'object' }),
    };
    assert.deepEqual(buildStudyResults([source]), []);
  });

  it('prefers dataWindowView() values over valuesProvider when both are present', () => {
    const source = {
      metaInfo: () => ({ description: 'Custom Study' }),
      dataWindowView: () => ({ items: () => [dwItem('Primary', 1)] }),
      valuesProvider: () => [{ title: 'Should not be used', value: 2 }],
    };
    const results = buildStudyResults([source]);
    assert.deepEqual(results[0].values, { Primary: 1 });
  });
});

describe('buildStudyResults() — multiple instances of the same indicator (#143)', () => {
  it('keeps two instances of the same indicator distinguishable by id + inputs', () => {
    const makeEma = (id, length, value) => ({
      metaInfo: () => ({ description: 'Moving Average Exponential' }),
      dataWindowView: () => ({ items: () => [dwItem('EMA', value)] }),
      id: () => id,
      inputs: () => ({ length }),
    });
    const results = buildStudyResults([makeEma('ema_9', 9, 100.5), makeEma('ema_21', 21, 98.2)]);
    assert.equal(results.length, 2);
    assert.deepEqual(results[0], { id: 'ema_9', name: 'Moving Average Exponential', inputs: { length: 9 }, values: { EMA: 100.5 } });
    assert.deepEqual(results[1], { id: 'ema_21', name: 'Moving Average Exponential', inputs: { length: 21 }, values: { EMA: 98.2 } });
  });

  it('mixes a legacy-path source and a fallback-path source in one call', () => {
    const legacy = {
      metaInfo: () => ({ description: 'RSI' }),
      dataWindowView: () => ({ items: () => [dwItem('RSI', 50)] }),
      id: () => 'ifEi6z',
    };
    const fallback = {
      metaInfo: () => { throw new Error('unusable'); },
      _studyMetaInfo: { description: 'MACD' },
      dataWindowView: () => ({ items: () => [dwItem('MACD', 0.1)] }),
      id: () => '51L80P',
    };
    const results = buildStudyResults([legacy, fallback]);
    assert.equal(results.length, 2);
    assert.equal(results[0].name, 'RSI');
    assert.equal(results[1].name, 'MACD');
  });
});

describe('buildStudyResults() — legitimate falsy values are preserved', () => {
  it('keeps a numeric 0 value from dataWindowView()', () => {
    const source = {
      metaInfo: () => ({ description: 'Zero Study' }),
      dataWindowView: () => ({ items: () => [dwItem('Delta', 0)] }),
    };
    const results = buildStudyResults([source]);
    assert.deepEqual(results[0].values, { Delta: 0 });
  });

  it('keeps a numeric 0 value from valuesProvider()', () => {
    const source = {
      metaInfo: () => ({ description: 'Zero Provider Study' }),
      dataWindowView: () => ({ items: () => [] }),
      valuesProvider: () => [{ title: 'Plot 0', value: 0 }],
    };
    const results = buildStudyResults([source]);
    assert.deepEqual(results[0].values, { 'Plot 0': 0 });
  });

  it('keeps a string "0" value', () => {
    const source = {
      metaInfo: () => ({ description: 'String Zero Study' }),
      dataWindowView: () => ({ items: () => [dwItem('Signal', '0')] }),
    };
    const results = buildStudyResults([source]);
    assert.deepEqual(results[0].values, { Signal: '0' });
  });

  it('keeps a boolean false value', () => {
    const source = {
      metaInfo: () => ({ description: 'Boolean Study' }),
      dataWindowView: () => ({ items: () => [dwItem('Crossed', false)] }),
    };
    const results = buildStudyResults([source]);
    assert.deepEqual(results[0].values, { Crossed: false });
  });

  it('still excludes null, undefined, empty string, and the "∅" sentinel', () => {
    const source = {
      metaInfo: () => ({ description: 'Mixed Study' }),
      dataWindowView: () => ({
        items: () => [
          dwItem('NullVal', null),
          dwItem('UndefinedVal', undefined),
          dwItem('EmptyVal', ''),
          dwItem('SentinelVal', '∅'),
          dwItem('Kept', 1),
        ],
      }),
    };
    const results = buildStudyResults([source]);
    assert.deepEqual(results[0].values, { Kept: 1 });
  });
});

describe('buildStudyResults() — robustness against a throwing _studyMetaInfo getter', () => {
  it('does not abort when _studyMetaInfo getter throws, and still processes a later valid study', () => {
    const throwing = {
      metaInfo: () => { throw new Error('metaInfo unusable'); },
      get _studyMetaInfo() { throw new Error('getter blew up'); },
      dataWindowView: () => ({ items: () => [dwItem('X', 1)] }),
    };
    const valid = {
      metaInfo: () => ({ description: 'Valid Study' }),
      dataWindowView: () => ({ items: () => [dwItem('RSI', 42)] }),
    };
    const results = buildStudyResults([throwing, valid]);
    assert.equal(results.length, 1);
    assert.equal(results[0].name, 'Valid Study');
    assert.deepEqual(results[0].values, { RSI: 42 });
  });
});

describe('buildStudyResults() — read-only guarantee', () => {
  it('never calls anything other than the known read-only accessors', () => {
    const allowed = new Set(['metaInfo', 'dataWindowView', 'items', 'id', 'inputs', 'valuesProvider', 'legendValuesProvider', 'value']);
    const calls = [];
    function spy(name, impl) {
      const fn = (...args) => { calls.push(name); return impl(...args); };
      return fn;
    }
    const source = {
      metaInfo: spy('metaInfo', () => ({ description: 'Spy Study' })),
      dataWindowView: spy('dataWindowView', () => ({
        items: spy('items', () => [dwItem('X', 1)]),
      })),
      id: spy('id', () => 'spy_1'),
      inputs: spy('inputs', () => ({ length: 5 })),
      // Mutating members that must never be invoked by a read-only tool.
      setValue: () => { throw new Error('mutation: setValue must not be called'); },
      requestMoreData: () => { throw new Error('mutation: requestMoreData must not be called'); },
      remove: () => { throw new Error('mutation: remove must not be called'); },
    };
    const results = buildStudyResults([source]);
    assert.equal(results.length, 1);
    for (const call of calls) assert.ok(allowed.has(call), `unexpected call: ${call}`);
  });

  it('does not throw or mutate state when a source is a bare, minimal object', () => {
    assert.doesNotThrow(() => buildStudyResults([{}, { metaInfo: () => null }, { _studyMetaInfo: null }]));
  });
});
