/**
 * Unit tests for buildOhlcvResult() (data_get_ohlcv payload construction).
 * Pure unit (no CDP, no TradingView Desktop required).
 *
 * Covers the atomic chart-identity binding: getOhlcv() reads chart identity
 * (symbol/resolution/chart type) and the bars inside the SAME Runtime.evaluate
 * from the SAME active chart widget; buildOhlcvResult() must propagate that
 * identity into both summary and full payloads and fail closed when the
 * identity is missing or malformed.
 *
 * Run: node --test tests/ohlcv_identity.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildOhlcvResult } from '../src/core/data.js';

const DAY = 86400;

function makeData({ chart, barCount = 6 } = {}) {
  const bars = [];
  for (let i = 0; i < barCount; i += 1) {
    const time = 1784246400 - (barCount - 1 - i) * DAY;
    bars.push({ time, open: 100 + i, high: 110 + i, low: 90 + i, close: 105 + i, volume: 1000 + i });
  }
  return {
    chart: chart === undefined
      ? { symbol: 'BINANCE:BTCUSDT', resolution: '1D', chart_type: 1 }
      : chart,
    bars,
    total_bars: 385,
    source: 'direct_bars_with_identity',
  };
}

describe('buildOhlcvResult() — identity propagation', () => {
  it('includes the chart identity block in summary mode', () => {
    const result = buildOhlcvResult(makeData(), { summary: true });
    assert.deepEqual(result.chart, { symbol: 'BINANCE:BTCUSDT', resolution: '1D', chart_type: 1 });
    assert.equal(result.success, true);
    assert.equal(result.bar_count, 6);
    assert.equal(result.last_5_bars.length, 5);
    assert.deepEqual(result.period, { from: result.last_5_bars[0].time - DAY, to: 1784246400 });
  });

  it('includes the chart identity block in full (non-summary) mode', () => {
    const result = buildOhlcvResult(makeData(), {});
    assert.deepEqual(result.chart, { symbol: 'BINANCE:BTCUSDT', resolution: '1D', chart_type: 1 });
    assert.equal(result.bar_count, 6);
    assert.equal(result.total_available, 385);
    assert.equal(result.source, 'direct_bars_with_identity');
    assert.equal(result.bars.length, 6);
  });

  it('copies only symbol/resolution/chart_type into the chart block', () => {
    const data = makeData({
      chart: { symbol: 'BINANCE:BTCUSDT', resolution: '1D', chart_type: 1, extra: 'x' },
    });
    const result = buildOhlcvResult(data, { summary: true });
    assert.deepEqual(Object.keys(result.chart).sort(), ['chart_type', 'resolution', 'symbol']);
  });

  it('keeps summary aggregate semantics unchanged', () => {
    const result = buildOhlcvResult(makeData(), { summary: true });
    assert.equal(result.open, 100);
    assert.equal(result.close, 110);
    assert.equal(result.high, 115);
    assert.equal(result.low, 90);
    assert.equal(result.range, 25);
    assert.equal(result.change, 10);
  });
});

describe('buildOhlcvResult() — fail-closed identity validation', () => {
  it('throws when the chart identity is missing entirely', () => {
    assert.throws(
      () => buildOhlcvResult(makeData({ chart: null }), { summary: true }),
      /chart identity/,
    );
  });

  it('throws when the symbol is missing or empty', () => {
    assert.throws(
      () => buildOhlcvResult(makeData({ chart: { symbol: '', resolution: '1D', chart_type: 1 } })),
      /chart identity/,
    );
  });

  it('throws when the resolution is not a string', () => {
    assert.throws(
      () => buildOhlcvResult(makeData({ chart: { symbol: 'X:Y', resolution: 86400, chart_type: 1 } })),
      /chart identity/,
    );
  });

  it('throws when the chart type is not an integer', () => {
    assert.throws(
      () => buildOhlcvResult(makeData({ chart: { symbol: 'X:Y', resolution: '1D', chart_type: '1' } })),
      /chart identity/,
    );
  });

  it('keeps the legacy loading error for missing bars', () => {
    assert.throws(
      () => buildOhlcvResult({ chart: { symbol: 'X:Y', resolution: '1D', chart_type: 1 }, bars: [] }),
      /still be loading/,
    );
  });
});
