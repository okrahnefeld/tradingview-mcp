/**
 * Offline contract tests for data_get_study_history.
 * No CDP, MCP transport, browser, network, or TradingView access is used.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {
  buildOhlcvResult,
  buildStudyHistoryResult,
  buildStudyResults,
  extractAlignedOhlcvRows,
  extractHistoricalStudyRows,
  getStudyHistory,
  normalizeStudyHistoryRequest,
  readAtomicStudyHistorySnapshot,
} from '../src/core/data.js';
import { registerDataTools, studyHistoryRequestSchema } from '../src/tools/data.js';

const WEEK = 604800;
const FIRST_STUDY_TIME = 1567382400;
const FIRST_PRICE_TIME = 1603670400;
const LAST_TIME = 1784505600;
const MIN_UNIX_TIME = -62167219200;
const MAX_UNIX_TIME = 253402300799;
const CHART = Object.freeze({
  symbol: 'BINANCE:BTCUSDT.P',
  resolution: '1W',
  chart_type: 19,
});
const ATOMIC_CONTEXT = Object.freeze({
  runtime_read_count: 1,
  synchronous: true,
  same_active_chart_object: true,
  identity_stable: true,
});
const BASE_REQUEST = Object.freeze({
  entity_id: 'aR3L6Z',
  plot_ids: ['plot_5', 'plot_9', 'plot_10'],
  count: 300,
  include_ohlcv: true,
});

function makePlotMetadata() {
  return Array.from({ length: 11 }, (_, ordinal) => ({
    ordinal,
    id: `plot_${ordinal}`,
    type: ordinal === 10 ? 'colorer' : 'line',
    target: ordinal === 10 ? 'plot_9' : null,
    title: `Plot ${ordinal}`,
  }));
}

function makeBar(time, overrides = {}) {
  return {
    time,
    open: 100,
    high: 110,
    low: 90,
    close: 105,
    volume: 1000,
    ...overrides,
  };
}

function makeStudyRows(count = 360) {
  return Array.from({ length: count }, (_, index) => ({
    time: FIRST_STUDY_TIME + index * WEEK,
    values: {
      plot_5: index - 100,
      plot_9: index === 358 ? 0 : index * -2,
      plot_10: index === 357 ? false : 4286683400 + index,
    },
  }));
}

function makeOhlcvRows(count = 300, firstTime = FIRST_PRICE_TIME) {
  return Array.from({ length: count }, (_, index) => (
    makeBar(firstTime + index * WEEK, {
      open: 100 + index,
      high: 110 + index,
      low: 90 + index,
      close: 105 + index,
      volume: index === 0 ? null : index === 1 ? 0 : 1000 + index,
    })
  ));
}

function makeStudy(overrides = {}) {
  return {
    entity_id: 'aR3L6Z',
    script_id: 'USER;48645c181e5f4b5c9a84529105d10fd4',
    pine_version: '28.0',
    description: 'Auto Swing Active Engine | POC Migration Tracker',
    meta_id: 'Script$USER;48645c181e5f4b5c9a84529105d10fd4@tv-scripting',
    meta_version: 101,
    plots: makePlotMetadata(),
    rows: makeStudyRows(),
    ...overrides,
  };
}

function makeSnapshot(overrides = {}) {
  return {
    chart: { ...CHART },
    identity_before: { ...CHART },
    identity_after: { ...CHART },
    atomic_context: { ...ATOMIC_CONTEXT },
    studies: [makeStudy()],
    ohlcv_rows: makeOhlcvRows(),
    ...overrides,
  };
}

function request(overrides = {}) {
  return { ...BASE_REQUEST, ...overrides };
}

describe('data_get_study_history — verified atomic success contract', () => {
  it('reports the observed 360/300 weekly runtime window truthfully', async () => {
    let reads = 0;
    const result = await getStudyHistory(request(), {
      readAtomicSnapshot: async (normalized) => {
        reads += 1;
        assert.deepEqual(normalized, BASE_REQUEST);
        return makeSnapshot();
      },
    });

    assert.equal(reads, 1);
    assert.deepEqual(result.chart, CHART);
    assert.deepEqual(result.atomic_context, ATOMIC_CONTEXT);
    assert.deepEqual(result.study, {
      entity_id: 'aR3L6Z',
      script_id: 'USER;48645c181e5f4b5c9a84529105d10fd4',
      pine_version: '28.0',
      description: 'Auto Swing Active Engine | POC Migration Tracker',
      meta_id: 'Script$USER;48645c181e5f4b5c9a84529105d10fd4@tv-scripting',
      meta_version: 101,
    });
    assert.deepEqual(result.plots, [
      { ordinal: 5, id: 'plot_5', type: 'line', target: null, title: 'Plot 5' },
      { ordinal: 9, id: 'plot_9', type: 'line', target: null, title: 'Plot 9' },
      { ordinal: 10, id: 'plot_10', type: 'colorer', target: 'plot_9', title: 'Plot 10' },
    ]);
    assert.deepEqual(result.history, {
      scope: 'currently_loaded_runtime_data',
      global_history_complete_known: false,
      study_loaded_count: 360,
      ohlcv_loaded_count: 300,
      aligned_loaded_count: 300,
    });
    assert.equal(result.loaded_count, 300);
    assert.equal(result.returned_count, 300);
    assert.equal(result.truncated, false);
    assert.equal(result.study_rows[0].time, FIRST_PRICE_TIME);
    assert.equal(result.study_rows.at(-1).time, LAST_TIME);
    assert.deepEqual(
      result.study_rows.map(row => row.time),
      result.ohlcv_rows.map(row => row.time),
    );
    assert.ok(!Object.hasOwn(result.study_rows.at(-1), 'closed'));
    assert.ok(!Object.hasOwn(result.ohlcv_rows.at(-1), 'closed'));
  });

  it('allows optional null metadata only at the pure offline builder boundary', () => {
    const study = makeStudy({
      script_id: null,
      pine_version: null,
      description: null,
      meta_id: null,
      meta_version: null,
    });
    const result = buildStudyHistoryResult(
      makeSnapshot({ studies: [study], ohlcv_rows: undefined }),
      request({ count: 500, include_ohlcv: false }),
    );
    assert.deepEqual(result.study, {
      entity_id: 'aR3L6Z',
      script_id: null,
      pine_version: null,
      description: null,
      meta_id: null,
      meta_version: null,
    });
  });
});

describe('data_get_study_history — strict request schema', () => {
  const invalidRequests = [
    ['missing entity_id', { plot_ids: ['plot_5'], count: 1, include_ohlcv: true }],
    ['empty entity_id', request({ entity_id: '' })],
    ['blank entity_id', request({ entity_id: '   ' })],
    ['too-long entity_id', request({ entity_id: 'x'.repeat(129) })],
    ['empty plot_ids', request({ plot_ids: [] })],
    ['duplicate plot_ids', request({ plot_ids: ['plot_5', 'plot_5'] })],
    ['too many plot_ids', request({ plot_ids: Array.from({ length: 17 }, (_, i) => `plot_${i}`) })],
    ['empty plot ID', request({ plot_ids: [''] })],
    ['count below minimum', request({ count: 0 })],
    ['count above maximum', request({ count: 501 })],
    ['non-integer count', request({ count: 1.5 })],
    ['coercible string count', request({ count: '3' })],
    ['non-boolean include_ohlcv', request({ include_ohlcv: 1 })],
    ['unknown argument', { ...request(), extra: true }],
  ];

  it('accepts only the exact authorized request shape without coercion', () => {
    assert.equal(studyHistoryRequestSchema.safeParse(request()).success, true);
    assert.deepEqual(normalizeStudyHistoryRequest(request()), BASE_REQUEST);
    for (const [name, value] of invalidRequests) {
      assert.equal(studyHistoryRequestSchema.safeParse(value).success, false, name);
      assert.throws(() => normalizeStudyHistoryRequest(value), undefined, name);
    }
  });

  it('preserves requested plot order while retaining actual ordinals', () => {
    const result = buildStudyHistoryResult(
      makeSnapshot(),
      request({ plot_ids: ['plot_10', 'plot_5'] }),
    );
    assert.deepEqual(result.plots.map(plot => [plot.id, plot.ordinal]), [
      ['plot_10', 10],
      ['plot_5', 5],
    ]);
    assert.deepEqual(Object.keys(result.study_rows[0].values), ['plot_10', 'plot_5']);
  });
});

describe('data_get_study_history — exact study and plot identity', () => {
  it('rejects absent and ambiguous exact entity IDs', () => {
    assert.throws(
      () => buildStudyHistoryResult(makeSnapshot({ studies: [] }), request()),
      /Study not found/,
    );
    assert.throws(
      () => buildStudyHistoryResult(makeSnapshot({ studies: [makeStudy(), makeStudy()] }), request()),
      /Multiple studies/,
    );
  });

  it('selects only by plot ID and never substitutes a matching title', () => {
    const plots = makePlotMetadata();
    plots[5] = { ...plots[5], id: 'real_id', title: 'plot_5' };
    assert.throws(
      () => buildStudyHistoryResult(makeSnapshot({ studies: [makeStudy({ plots })] }), request()),
      /Requested plot ID not found/,
    );
  });

  it('rejects duplicate IDs and ordinals not derived from metaInfo.plots position', () => {
    const duplicatePlots = makePlotMetadata();
    duplicatePlots[6] = { ...duplicatePlots[6], id: 'plot_5' };
    assert.throws(
      () => buildStudyHistoryResult(
        makeSnapshot({ studies: [makeStudy({ plots: duplicatePlots })] }),
        request({ plot_ids: ['plot_5'] }),
      ),
      /Duplicate plot ID/,
    );

    const wrongOrdinal = makePlotMetadata();
    wrongOrdinal[5] = { ...wrongOrdinal[5], ordinal: 4 };
    assert.throws(
      () => buildStudyHistoryResult(
        makeSnapshot({ studies: [makeStudy({ plots: wrongOrdinal })] }),
        request({ plot_ids: ['plot_5'] }),
      ),
      /ordinal/,
    );
  });

  it('rejects malformed or non-array plot metadata', () => {
    for (const plots of [null, {}, 'plots']) {
      assert.throws(
        () => buildStudyHistoryResult(makeSnapshot({ studies: [makeStudy({ plots })] }), request()),
        /plot metadata/,
      );
    }
    const plots = makePlotMetadata();
    plots[3] = null;
    assert.throws(
      () => buildStudyHistoryResult(makeSnapshot({ studies: [makeStudy({ plots })] }), request()),
      /plot metadata/,
    );
  });
});

describe('data_get_study_history — chart identity and atomicity', () => {
  it('accepts any valid integer chart type and rejects malformed identity fields', () => {
    const customChart = { ...CHART, chart_type: -7 };
    const result = buildStudyHistoryResult(makeSnapshot({
      chart: customChart,
      identity_before: customChart,
      identity_after: customChart,
    }), request());
    assert.equal(result.chart.chart_type, -7);

    for (const chart of [
      { symbol: '', resolution: '1W', chart_type: 19 },
      { symbol: CHART.symbol, resolution: null, chart_type: 19 },
      { symbol: CHART.symbol, resolution: '1W', chart_type: '19' },
    ]) {
      assert.throws(
        () => buildStudyHistoryResult(makeSnapshot({ chart, identity_before: chart }), request()),
        /chart identity/,
      );
    }
  });

  it('fails closed for every declared atomic-context invariant', () => {
    const cases = [
      makeSnapshot({ atomic_context: null }),
      makeSnapshot({ atomic_context: { ...ATOMIC_CONTEXT, runtime_read_count: 2 } }),
      makeSnapshot({ atomic_context: { ...ATOMIC_CONTEXT, synchronous: false } }),
      makeSnapshot({ atomic_context: { ...ATOMIC_CONTEXT, same_active_chart_object: false } }),
      makeSnapshot({ atomic_context: { ...ATOMIC_CONTEXT, identity_stable: false } }),
    ];
    for (const snapshot of cases) {
      assert.throws(() => buildStudyHistoryResult(snapshot, request()), /Atomic|atomic|chart|identity/);
    }
  });

  it('compares identity_before and identity_after instead of trusting a flag', () => {
    assert.throws(
      () => buildStudyHistoryResult(makeSnapshot({
        identity_after: { ...CHART, resolution: '1D' },
      }), request()),
      /identity changed/,
    );
    assert.throws(
      () => buildStudyHistoryResult(makeSnapshot({
        chart: { ...CHART, symbol: 'NASDAQ:AAPL' },
      }), request()),
      /does not match/,
    );
  });
});

describe('data_get_study_history — native study-time and value semantics', () => {
  it('sorts ascending without shifting values between timestamps', () => {
    const rows = [
      { time: FIRST_STUDY_TIME + 2 * WEEK, values: { a: 3, b: 30 } },
      { time: FIRST_STUDY_TIME, values: { a: 1, b: 10 } },
      { time: FIRST_STUDY_TIME + WEEK, values: { a: 2, b: 20 } },
    ];
    assert.deepEqual(extractHistoricalStudyRows(rows, ['b', 'a']), [
      { time: FIRST_STUDY_TIME, values: { b: 10, a: 1 } },
      { time: FIRST_STUDY_TIME + WEEK, values: { b: 20, a: 2 } },
      { time: FIRST_STUDY_TIME + 2 * WEEK, values: { b: 30, a: 3 } },
    ]);
  });

  it('accepts empty loaded study history with truthful zero counts', () => {
    const result = buildStudyHistoryResult(
      makeSnapshot({ studies: [makeStudy({ rows: [] })] }),
      request(),
    );
    assert.deepEqual(result.study_rows, []);
    assert.deepEqual(result.ohlcv_rows, []);
    assert.equal(result.history.study_loaded_count, 0);
    assert.equal(result.history.aligned_loaded_count, 0);
    assert.equal(result.loaded_count, 0);
    assert.equal(result.returned_count, 0);
    assert.equal(result.truncated, false);
  });

  it('rejects duplicate timestamps and malformed/non-array study rows', () => {
    assert.throws(
      () => extractHistoricalStudyRows([
        { time: FIRST_STUDY_TIME, values: { a: 1 } },
        { time: FIRST_STUDY_TIME, values: { a: 2 } },
      ], ['a']),
      /Duplicate study timestamp/,
    );
    for (const rows of [null, {}, 'rows']) {
      assert.throws(() => extractHistoricalStudyRows(rows, ['a']), /unavailable/);
    }
    for (const row of [null, [], { time: FIRST_STUDY_TIME, values: [] }]) {
      assert.throws(() => extractHistoricalStudyRows([row], ['a']), /malformed/);
    }
  });

  it('enforces inclusive Unix-second boundaries and rejects adjacent values', () => {
    assert.deepEqual(
      extractHistoricalStudyRows([
        { time: MAX_UNIX_TIME, values: { a: 2 } },
        { time: MIN_UNIX_TIME, values: { a: 1 } },
      ], ['a']).map(row => row.time),
      [MIN_UNIX_TIME, MAX_UNIX_TIME],
    );
    for (const time of [MIN_UNIX_TIME - 1, MAX_UNIX_TIME + 1, 1.5, NaN, Infinity, 1784505600000]) {
      assert.throws(
        () => extractHistoricalStudyRows([{ time, values: { a: 1 } }], ['a']),
        /seconds/,
      );
    }
  });

  it('maps missing values to null and preserves 0, false, negatives, and ARGB integers', () => {
    const [row] = extractHistoricalStudyRows([{
      time: LAST_TIME,
      values: { zero: 0, bool: false, negative: -2, argb: 4286683400 },
    }], ['missing', 'zero', 'bool', 'negative', 'argb']);
    assert.deepEqual(row.values, {
      missing: null,
      zero: 0,
      bool: false,
      negative: -2,
      argb: 4286683400,
    });
  });

  it('rejects NaN, Infinity, and string study values', () => {
    for (const value of [NaN, Infinity, -Infinity, '12.5']) {
      assert.throws(
        () => extractHistoricalStudyRows([{
          time: LAST_TIME,
          values: { plot_5: value },
        }], ['plot_5']),
        /finite numeric/,
      );
    }
  });
});

describe('data_get_study_history — exact OHLCV alignment and validity', () => {
  it('aligns exact timestamps in study order and ignores unrelated extra rows', () => {
    const studyRows = [
      { time: FIRST_STUDY_TIME, values: {} },
      { time: FIRST_STUDY_TIME + WEEK, values: {} },
    ];
    const rows = [
      makeBar(FIRST_STUDY_TIME + WEEK),
      makeBar(FIRST_STUDY_TIME - 123),
      makeBar(FIRST_STUDY_TIME),
      makeBar(FIRST_STUDY_TIME + 2 * WEEK),
    ];
    assert.deepEqual(
      extractAlignedOhlcvRows(rows, studyRows).map(row => row.time),
      studyRows.map(row => row.time),
    );
  });

  it('requires an OHLCV container when include_ohlcv=true', () => {
    for (const ohlcv_rows of [undefined, null, {}]) {
      assert.throws(
        () => buildStudyHistoryResult(makeSnapshot({ ohlcv_rows }), request()),
        /OHLCV rows are unavailable/,
      );
    }
  });

  it('excludes unaligned study rows before applying count and exposes the gap', () => {
    const result = buildStudyHistoryResult(
      makeSnapshot({ ohlcv_rows: makeOhlcvRows(299, FIRST_PRICE_TIME + WEEK) }),
      request({ count: 500 }),
    );
    assert.equal(result.history.study_loaded_count, 360);
    assert.equal(result.history.ohlcv_loaded_count, 299);
    assert.equal(result.history.aligned_loaded_count, 299);
    assert.equal(result.loaded_count, 299);
    assert.equal(result.returned_count, 299);
    assert.equal(result.study_rows[0].time, FIRST_PRICE_TIME + WEEK);
  });

  it('rejects duplicate OHLCV timestamps and invalid OHLC values', () => {
    assert.throws(
      () => extractAlignedOhlcvRows([
        makeBar(FIRST_STUDY_TIME),
        makeBar(FIRST_STUDY_TIME),
      ], [{ time: FIRST_STUDY_TIME }]),
      /Duplicate OHLCV timestamp/,
    );
    for (const row of [
      makeBar(FIRST_STUDY_TIME, { open: '100' }),
      makeBar(FIRST_STUDY_TIME, { close: Infinity }),
      makeBar(FIRST_STUDY_TIME, { high: 104, close: 105 }),
      makeBar(FIRST_STUDY_TIME, { low: 106, close: 105 }),
    ]) {
      assert.throws(
        () => extractAlignedOhlcvRows([row], [{ time: FIRST_STUDY_TIME }]),
        /OHLCV/,
      );
    }
  });

  it('rejects negative volume and distinguishes missing volume from genuine zero', () => {
    assert.throws(
      () => extractAlignedOhlcvRows([
        makeBar(FIRST_STUDY_TIME, { volume: -1 }),
      ], [{ time: FIRST_STUDY_TIME }]),
      /non-negative/,
    );
    const result = extractAlignedOhlcvRows([
      makeBar(FIRST_STUDY_TIME, { volume: undefined }),
      makeBar(FIRST_STUDY_TIME + WEEK, { volume: null }),
      makeBar(FIRST_STUDY_TIME + 2 * WEEK, { volume: 0 }),
    ], [
      { time: FIRST_STUDY_TIME },
      { time: FIRST_STUDY_TIME + WEEK },
      { time: FIRST_STUDY_TIME + 2 * WEEK },
    ]);
    assert.deepEqual(result.map(row => row.volume), [null, null, 0]);
  });
});

describe('data_get_study_history — completeness, count, and truncation semantics', () => {
  it('applies count after the aligned intersection and selects newest rows', () => {
    const result = buildStudyHistoryResult(makeSnapshot(), request({ count: 2 }));
    assert.deepEqual(result.study_rows.map(row => row.time), [LAST_TIME - WEEK, LAST_TIME]);
    assert.deepEqual(result.ohlcv_rows.map(row => row.time), [LAST_TIME - WEEK, LAST_TIME]);
    assert.equal(result.loaded_count, 300);
    assert.equal(result.returned_count, 2);
    assert.equal(result.truncated, true);
    assert.equal(result.history.global_history_complete_known, false);
  });

  it('counts additional non-needed OHLCV rows without treating them as aligned', () => {
    const extra = makeBar(FIRST_STUDY_TIME - WEEK);
    const result = buildStudyHistoryResult(
      makeSnapshot({ ohlcv_rows: [extra, ...makeOhlcvRows()] }),
      request(),
    );
    assert.equal(result.history.ohlcv_loaded_count, 301);
    assert.equal(result.history.aligned_loaded_count, 300);
    assert.equal(result.loaded_count, 300);
    assert.equal(result.truncated, false);
  });

  it('uses study history directly and does not require OHLCV when disabled', () => {
    const result = buildStudyHistoryResult(
      makeSnapshot({ ohlcv_rows: undefined }),
      request({ count: 500, include_ohlcv: false }),
    );
    assert.equal(result.ohlcv_rows, null);
    assert.deepEqual(result.history, {
      scope: 'currently_loaded_runtime_data',
      global_history_complete_known: false,
      study_loaded_count: 360,
      ohlcv_loaded_count: null,
      aligned_loaded_count: null,
    });
    assert.equal(result.loaded_count, 360);
    assert.equal(result.returned_count, 360);
    assert.equal(result.truncated, false);
    assert.equal(result.study_rows[0].time, FIRST_STUDY_TIME);
  });
});

function makeRuntimeFixture({
  pineId = 'USER;48645c181e5f4b5c9a84529105d10fd4',
  pineVersion = '28.0',
  afterChart = null,
} = {}) {
  const calls = [];
  const mutations = [];
  const plots = makePlotMetadata().map(({ id, type, target, title }) => ({ id, type, target, title }));
  const rawRows = [
    { index: 700, value: [FIRST_PRICE_TIME, null, null, null, null, null, -4, null, null, null, 0, false] },
    { index: 701, value: [FIRST_PRICE_TIME + WEEK, null, null, null, null, null, 0, null, null, null, -2, 4286683400] },
  ];
  const study = {
    id: () => { calls.push('study.id'); return 'aR3L6Z'; },
    inputs: () => { calls.push('study.inputs'); return { pineId, pineVersion }; },
    metaInfo: () => {
      calls.push('study.metaInfo');
      return {
        description: 'Auto Swing Active Engine | POC Migration Tracker',
        shortDescription: 'Not selected',
        id: 'Script$USER;48645c181e5f4b5c9a84529105d10fd4@tv-scripting',
        version: 101,
        plots,
      };
    },
    data: () => {
      calls.push('study.data');
      return {
        plottableRange: () => {
          calls.push('study.plottableRange');
          return { _items: rawRows };
        },
      };
    },
    setValue: () => mutations.push('setValue'),
    requestMoreData: () => mutations.push('requestMoreData'),
  };
  const barsData = [
    [FIRST_PRICE_TIME, 100, 110, 90, 105],
    [FIRST_PRICE_TIME + WEEK, 105, 115, 95, 110, 0],
  ];
  const bars = {
    firstIndex: () => { calls.push('bars.firstIndex'); return 0; },
    lastIndex: () => { calls.push('bars.lastIndex'); return 1; },
    valueAt: index => { calls.push(`bars.valueAt:${index}`); return barsData[index]; },
    requestMoreData: () => mutations.push('bars.requestMoreData'),
  };
  const chartModel = {
    model: () => ({ dataSources: () => { calls.push('dataSources'); return [study]; } }),
    mainSeries: () => ({ bars: () => { calls.push('mainSeries.bars'); return bars; } }),
  };
  const activeChart = {
    symbol: () => CHART.symbol,
    resolution: () => CHART.resolution,
    chartType: () => CHART.chart_type,
    _chartWidget: { model: () => chartModel },
    setSymbol: () => mutations.push('setSymbol'),
    setResolution: () => mutations.push('setResolution'),
    createStudy: () => mutations.push('createStudy'),
    removeEntity: () => mutations.push('removeEntity'),
  };
  let activeReads = 0;
  const activeChartAfter = afterChart || activeChart;
  const window = {
    TradingViewApi: {
      _activeChartWidgetWV: {
        value: () => {
          activeReads += 1;
          calls.push(`activeChart:${activeReads}`);
          return activeReads === 1 ? activeChart : activeChartAfter;
        },
      },
    },
  };
  return { window, calls, mutations };
}

async function executeRuntimeAdapter(runtime, requestOverrides = {}) {
  let runtimeReads = 0;
  let expressionSeen = null;
  const snapshot = await readAtomicStudyHistorySnapshot(
    request({ count: 2, ...requestOverrides }),
    {
      runtimeEvaluate: async (expression) => {
        runtimeReads += 1;
        expressionSeen = expression;
        const value = vm.runInNewContext(expression, { window: runtime.window });
        assert.equal(typeof value?.then, 'undefined', 'page read must be synchronous');
        return value;
      },
    },
  );
  return { snapshot, runtimeReads, expressionSeen };
}

describe('readAtomicStudyHistorySnapshot() — operational offline runtime emulation', () => {
  it('uses one synchronous page read and the verified native containers', async () => {
    const runtime = makeRuntimeFixture();
    const { snapshot, runtimeReads, expressionSeen } = await executeRuntimeAdapter(runtime);
    const plainSnapshot = JSON.parse(JSON.stringify(snapshot));

    assert.equal(runtimeReads, 1);
    assert.deepEqual(plainSnapshot.atomic_context, ATOMIC_CONTEXT);
    assert.deepEqual(plainSnapshot.identity_before, CHART);
    assert.deepEqual(plainSnapshot.identity_after, CHART);
    assert.equal(plainSnapshot.studies[0].rows[0].internal_index, 700);
    assert.deepEqual(plainSnapshot.studies[0].rows[0].values, {
      plot_5: -4,
      plot_9: 0,
      plot_10: false,
    });
    assert.deepEqual(plainSnapshot.studies[0].rows[1].values, {
      plot_5: 0,
      plot_9: -2,
      plot_10: 4286683400,
    });
    assert.deepEqual(plainSnapshot.ohlcv_rows.map(row => row.volume), [null, 0]);
    assert.ok(runtime.calls.includes('study.data'));
    assert.ok(runtime.calls.includes('study.plottableRange'));
    assert.ok(runtime.calls.includes('mainSeries.bars'));
    assert.deepEqual(runtime.mutations, []);
    assert.doesNotMatch(
      expressionSeen,
      /setSymbol|setResolution|requestMoreData|createStudy|removeEntity|setValue|Crosshair|Data Window/,
    );
  });

  it('fails closed when the active object or chart identity changes', async () => {
    const afterChart = {
      symbol: () => 'NASDAQ:AAPL',
      resolution: () => '1D',
      chartType: () => 19,
      _chartWidget: {},
    };
    await assert.rejects(
      () => executeRuntimeAdapter(makeRuntimeFixture({ afterChart })),
      /chart object changed|identity was not stable/,
    );
  });

  it('requires script_id and pine_version in the real runtime adapter', async () => {
    await assert.rejects(
      () => executeRuntimeAdapter(makeRuntimeFixture({ pineId: null })),
      /study.script_id/,
    );
    await assert.rejects(
      () => executeRuntimeAdapter(makeRuntimeFixture({ pineVersion: null })),
      /study.pine_version/,
    );
  });
});

describe('data_get_study_history — registration and regression boundaries', () => {
  it('keeps buildStudyResults/data_get_study_values semantics unchanged', () => {
    const source = {
      metaInfo: () => ({ description: 'Legacy Study' }),
      dataWindowView: () => ({ items: () => [{ _title: 'Value', _value: 0 }] }),
      id: () => 'legacy_1',
      inputs: () => ({ length: 14 }),
    };
    assert.deepEqual(buildStudyResults([source]), [
      { id: 'legacy_1', name: 'Legacy Study', inputs: { length: 14 }, values: { Value: 0 } },
    ]);
  });

  it('keeps buildOhlcvResult/data_get_ohlcv semantics unchanged', () => {
    const data = {
      chart: { symbol: 'X:Y', resolution: '1D', chart_type: 19 },
      bars: [makeBar(FIRST_STUDY_TIME)],
      total_bars: 1,
      source: 'direct_bars_with_identity',
    };
    assert.deepEqual(buildOhlcvResult(data), {
      success: true,
      chart: { symbol: 'X:Y', resolution: '1D', chart_type: 19 },
      bar_count: 1,
      total_available: 1,
      source: 'direct_bars_with_identity',
      bars: [makeBar(FIRST_STUDY_TIME)],
    });
  });

  it('registers a strict read-only open-world tool and serializes schema errors offline', async () => {
    let registration;
    const fakeServer = {
      tool() {},
      registerTool(name, config, handler) {
        if (name === 'data_get_study_history') registration = { ...config, handler };
      },
    };
    registerDataTools(fakeServer);
    assert.ok(registration);
    assert.equal(registration.inputSchema, studyHistoryRequestSchema);
    assert.deepEqual(registration.annotations, {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    });
    assert.equal(registration.inputSchema.safeParse({ ...request(), extra: true }).success, false);

    const response = await registration.handler({ ...request(), count: 0 });
    assert.equal(response.isError, true);
    const payload = JSON.parse(response.content[0].text);
    assert.equal(payload.success, false);
  });
});
