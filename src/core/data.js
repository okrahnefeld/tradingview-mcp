/**
 * Core data access logic.
 */
import {
  evaluate,
  evaluateAsync,
  evaluateSingleRuntimeRead,
  KNOWN_PATHS,
  safeString,
} from '../connection.js';
import { waitForChartReady } from '../wait.js';

const MAX_OHLCV_BARS = 500;
const MAX_TRADES = 20;
export const MAX_STUDY_HISTORY_COUNT = 500;
export const MAX_STUDY_HISTORY_PLOTS = 16;
export const MAX_STUDY_HISTORY_ID_LENGTH = 128;

// Round to 8 dp — enough to kill float noise (29899.999999997 → 29900) without
// destroying precision on forex/crypto prices. The old 2-dp rounding flattened
// sub-cent levels to 0.00 (issue #77).
const roundPrice = (v) => (v == null ? null : Math.round(v * 1e8) / 1e8);
const CHART_API = KNOWN_PATHS.chartApi;
const BARS_PATH = KNOWN_PATHS.mainSeriesBars;

// Serializes getQuote() calls that mutate chart symbol so concurrent callers
// can't race over the shared chart state. JS is single-threaded but our
// awaits interleave; without this every parallel quote_get(symbol) would
// read whichever symbol the chart happened to be on at evaluate() time.
let _quoteLock = Promise.resolve();

// Shared page-context JS: locate the strategy data source. Strategies are
// identified by metaInfo().isTVScriptStrategy / is_strategy — NOT by
// is_price_study===false (that was the #48/#173/#181 bug: strategies actually
// have is_price_study===true, so the old check excluded every one). Falls
// back to any source exposing reportData/ordersData.
const FIND_STRATEGY_JS = `
  function _reportOf(s) {
    try { var rd = s.reportData(); if (rd && typeof rd.value === 'function') rd = rd.value(); return rd; } catch (e) { return null; }
  }
  function findStrategies() {
    var chart = ${CHART_API}._chartWidget;
    var sources = chart.model().model().dataSources();
    var strategies = [];
    for (var i = 0; i < sources.length; i++) {
      var s = sources[i], mi = null;
      try { mi = s.metaInfo ? s.metaInfo() : null; } catch (e) {}
      var isStrat = mi && (mi.isTVScriptStrategy || mi.is_strategy);
      if ((isStrat || typeof s.reportData === 'function') && typeof s.reportData === 'function') {
        strategies.push({ s: s, name: mi ? mi.description : null });
      }
    }
    return strategies;
  }
  // Returns { strat, report } — prefers a strategy whose report is actually
  // computed (the one selected in the Strategy Tester panel). With multiple
  // strategies on the chart, only the selected one has non-null reportData,
  // so returning the first strategy blindly reads the wrong (empty) one.
  function findStrategy() {
    var strategies = findStrategies();
    // Prefer one with a computed report (has .performance).
    for (var j = 0; j < strategies.length; j++) {
      var rd = _reportOf(strategies[j].s);
      if (rd && rd.performance) return { strat: strategies[j].s, report: rd, name: strategies[j].name, strategy_count: strategies.length };
    }
    // None computed — return the first so callers can hint "open the panel".
    if (strategies.length) return { strat: strategies[0].s, report: null, name: strategies[0].name, strategy_count: strategies.length };
    return null;
  }
  // TradingView never computes a report for a hidden strategy (crossed-out eye
  // in the legend), so a hidden one looks identical to "panel not opened yet".
  // Unhide any hidden strategies and report their names so callers can tell
  // the user what changed.
  function unhideStrategies() {
    var unhidden = [];
    var strategies = findStrategies();
    for (var i = 0; i < strategies.length; i++) {
      var s = strategies[i].s;
      try {
        var vis = null;
        try { vis = s.properties().visible.value(); } catch (e) {}
        if (vis !== false) continue;
        var done = false;
        try { s.properties().visible.setValue(true); done = true; } catch (e) {}
        if (!done) {
          try { var st = ${CHART_API}.getStudyById(s.id()); if (st) { st.setVisible(true); done = true; } } catch (e) {}
        }
        if (done) unhidden.push(strategies[i].name || 'strategy');
      } catch (e) {}
    }
    return unhidden;
  }
`;

function buildGraphicsJS(collectionName, mapKey, filter) {
  return `
    (function() {
      var chart = window.TradingViewApi._activeChartWidgetWV.value()._chartWidget;
      var model = chart.model();
      var sources = model.model().dataSources();
      var results = [];
      var filter = ${safeString(filter || '')};
      for (var si = 0; si < sources.length; si++) {
        var s = sources[si];
        if (!s.metaInfo) continue;
        try {
          var meta = s.metaInfo();
          var name = meta.description || meta.shortDescription || '';
          if (!name) continue;
          if (filter && name.indexOf(filter) === -1) continue;
          var g = s._graphics;
          if (!g || !g._primitivesCollection) continue;
          var pc = g._primitivesCollection;
          var items = [];
          try {
            var outer = pc.${collectionName};
            if (outer) {
              var inner = outer.get('${mapKey}');
              if (inner) {
                var coll = inner.get(false);
                if (coll && coll._primitivesDataById && coll._primitivesDataById.size > 0) {
                  coll._primitivesDataById.forEach(function(v, id) { items.push({id: id, raw: v}); });
                }
              }
            }
          } catch(e) {}
          if (items.length === 0 && '${collectionName}' === 'dwgtablecells') {
            try {
              var tcOuter = pc.dwgtablecells;
              if (tcOuter) {
                var tcColl = tcOuter.get('tableCells');
                if (tcColl && tcColl._primitivesDataById && tcColl._primitivesDataById.size > 0) {
                  tcColl._primitivesDataById.forEach(function(v, id) { items.push({id: id, raw: v}); });
                }
              }
            } catch(e) {}
          }
          if (items.length > 0) results.push({name: name, count: items.length, items: items});
        } catch(e) {}
      }
      return results;
    })()
  `;
}

// Builds the getOhlcv() tool payload from one atomic page-side extraction.
// `data.chart` (symbol/resolution/chart type) and `data.bars` are read inside
// the SAME Runtime.evaluate from the SAME active chart widget object, so the
// identity is transactionally bound to the bars it describes. Exported as a
// pure function so it can be unit-tested without CDP (see
// tests/ohlcv_identity.test.js, same pattern as buildStudyResults()).
export function buildOhlcvResult(data, { summary } = {}) {
  if (!data || !data.bars || data.bars.length === 0) {
    throw new Error('Could not extract OHLCV data. The chart may still be loading.');
  }

  const identity = data.chart;
  if (!identity
    || typeof identity.symbol !== 'string' || identity.symbol.length === 0
    || typeof identity.resolution !== 'string' || identity.resolution.length === 0
    || !Number.isInteger(identity.chart_type)) {
    throw new Error('Could not read chart identity (symbol/resolution/chart type) for OHLCV data.');
  }
  const chart = {
    symbol: identity.symbol,
    resolution: identity.resolution,
    chart_type: identity.chart_type,
  };

  if (summary) {
    const bars = data.bars;
    const highs = bars.map(b => b.high);
    const lows = bars.map(b => b.low);
    const volumes = bars.map(b => b.volume);
    const first = bars[0];
    const last = bars[bars.length - 1];
    return {
      success: true, chart, bar_count: bars.length,
      period: { from: first.time, to: last.time },
      open: first.open, close: last.close,
      high: Math.max(...highs), low: Math.min(...lows),
      range: roundPrice(Math.max(...highs) - Math.min(...lows)),
      change: roundPrice(last.close - first.open),
      change_pct: Math.round(((last.close - first.open) / first.open) * 10000) / 100 + '%',
      avg_volume: Math.round(volumes.reduce((a, b) => a + b, 0) / volumes.length),
      last_5_bars: bars.slice(-5),
    };
  }

  return { success: true, chart, bar_count: data.bars.length, total_available: data.total_bars, source: data.source, bars: data.bars };
}

export async function getOhlcv({ count, summary } = {}) {
  const limit = Math.min(count || 100, MAX_OHLCV_BARS);
  let data;
  try {
    data = await evaluate(`
      (function() {
        var chart = ${CHART_API};
        if (!chart) return null;
        var identity;
        try {
          identity = {
            symbol: chart.symbol(),
            resolution: chart.resolution(),
            chart_type: chart.chartType()
          };
        } catch (e) { return null; }
        var bars;
        try { bars = chart._chartWidget.model().mainSeries().bars(); } catch (e) { return null; }
        if (!bars || typeof bars.lastIndex !== 'function') return null;
        var result = [];
        var end = bars.lastIndex();
        var start = Math.max(bars.firstIndex(), end - ${limit} + 1);
        for (var i = start; i <= end; i++) {
          var v = bars.valueAt(i);
          if (v) result.push({time: v[0], open: v[1], high: v[2], low: v[3], close: v[4], volume: v[5] || 0});
        }
        return {chart: identity, bars: result, total_bars: bars.size(), source: 'direct_bars_with_identity'};
      })()
    `);
  } catch { data = null; }

  return buildOhlcvResult(data, { summary });
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireBoundedId(value, name) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${name} must be a non-empty string.`);
  }
  if (value.length > MAX_STUDY_HISTORY_ID_LENGTH) {
    throw new Error(`${name} must be at most ${MAX_STUDY_HISTORY_ID_LENGTH} characters.`);
  }
  return value;
}

/**
 * Strict, dependency-free request validation for callers below the MCP/Zod
 * boundary. No coercion or implicit study/plot selection is permitted.
 */
export function normalizeStudyHistoryRequest(request) {
  if (!isRecord(request)) throw new Error('Study history request must be an object.');

  const allowedKeys = new Set(['entity_id', 'plot_ids', 'count', 'include_ohlcv']);
  const extraKeys = Object.keys(request).filter(key => !allowedKeys.has(key));
  if (extraKeys.length > 0) {
    throw new Error(`Unknown study history argument(s): ${extraKeys.join(', ')}.`);
  }

  const entity_id = requireBoundedId(request.entity_id, 'entity_id');
  if (!Array.isArray(request.plot_ids)
    || request.plot_ids.length < 1
    || request.plot_ids.length > MAX_STUDY_HISTORY_PLOTS) {
    throw new Error(`plot_ids must contain between 1 and ${MAX_STUDY_HISTORY_PLOTS} entries.`);
  }

  const plot_ids = request.plot_ids.map((plotId, index) => (
    requireBoundedId(plotId, `plot_ids[${index}]`)
  ));
  if (new Set(plot_ids).size !== plot_ids.length) {
    throw new Error('plot_ids must not contain duplicates.');
  }

  if (!Number.isInteger(request.count)
    || request.count < 1
    || request.count > MAX_STUDY_HISTORY_COUNT) {
    throw new Error(`count must be an integer between 1 and ${MAX_STUDY_HISTORY_COUNT}.`);
  }
  if (typeof request.include_ohlcv !== 'boolean') {
    throw new Error('include_ohlcv must be a boolean.');
  }

  return { entity_id, plot_ids, count: request.count, include_ohlcv: request.include_ohlcv };
}

function validateChartIdentity(identity) {
  if (!isRecord(identity)
    || typeof identity.symbol !== 'string' || identity.symbol.trim().length === 0
    || typeof identity.resolution !== 'string' || identity.resolution.trim().length === 0
    || !Number.isInteger(identity.chart_type)) {
    throw new Error('Could not read a valid atomic chart identity (symbol/resolution/chart type).');
  }
  return {
    symbol: identity.symbol,
    resolution: identity.resolution,
    chart_type: identity.chart_type,
  };
}

function chartIdentitiesEqual(left, right) {
  return left.symbol === right.symbol
    && left.resolution === right.resolution
    && left.chart_type === right.chart_type;
}

function nullableMetadataString(value, name) {
  if (value == null) return null;
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Study ${name} is malformed.`);
  }
  return value;
}

function nullableMetadataVersion(value) {
  if (value == null) return null;
  if ((typeof value !== 'string' && typeof value !== 'number')
    || (typeof value === 'string' && value.trim().length === 0)
    || (typeof value === 'number' && !Number.isFinite(value))) {
    throw new Error('Study meta_version is malformed.');
  }
  return value;
}

function validateUnixTime(time, context) {
  // Bound to the commonly representable proleptic-Gregorian Unix range.
  // Millisecond epochs (currently ~1e12) are therefore rejected rather than
  // being mislabeled as seconds.
  if (!Number.isInteger(time) || time < -62167219200 || time > 253402300799) {
    throw new Error(`${context} time must be an integer Unix timestamp in seconds.`);
  }
  return time;
}

function normalizeStudyValue(value, plotId, time) {
  if (value == null) return null;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  throw new Error(`Study value for plot ${plotId} at ${time} must be finite numeric, boolean, or null.`);
}

function extractStudyMetadata(study, requestedPlotIds) {
  if (!isRecord(study)) throw new Error('Selected study payload is malformed.');
  const entity_id = requireBoundedId(study.entity_id, 'study.entity_id');
  const script_id = nullableMetadataString(study.script_id, 'script_id');
  const pine_version = nullableMetadataString(study.pine_version, 'pine_version');
  const description = nullableMetadataString(study.description, 'description');
  const meta_id = nullableMetadataString(study.meta_id, 'meta_id');
  const meta_version = nullableMetadataVersion(study.meta_version);

  if (!Array.isArray(study.plots)) throw new Error('Selected study plot metadata is unavailable.');
  const plotsById = new Map();
  for (let ordinal = 0; ordinal < study.plots.length; ordinal++) {
    const plot = study.plots[ordinal];
    if (!isRecord(plot)) throw new Error('Selected study plot metadata is malformed.');
    const id = requireBoundedId(plot.id, 'study plot id');
    if (plotsById.has(id)) throw new Error(`Duplicate plot ID in study metadata: ${id}.`);
    if (plot.ordinal !== ordinal) {
      throw new Error(`Plot ordinal for ${id} does not match its metaInfo.plots position.`);
    }
    if (plot.type != null && typeof plot.type !== 'string') {
      throw new Error(`Plot type for ${id} is malformed.`);
    }
    if (plot.target != null && typeof plot.target !== 'string') {
      throw new Error(`Plot target for ${id} is malformed.`);
    }
    if (plot.title != null && typeof plot.title !== 'string') {
      throw new Error(`Plot title for ${id} is malformed.`);
    }
    plotsById.set(id, {
      ordinal,
      id,
      type: plot.type ?? null,
      target: plot.target ?? null,
      title: plot.title ?? null,
    });
  }

  const plots = requestedPlotIds.map((id) => {
    const plot = plotsById.get(id);
    if (!plot) throw new Error(`Requested plot ID not found in selected study: ${id}.`);
    return plot;
  });

  return {
    study: {
      entity_id,
      script_id,
      pine_version,
      description,
      meta_id,
      meta_version,
    },
    plots,
  };
}

/**
 * Convert adapter rows that already share one native TradingView time index
 * into strict, ordered response rows. A missing property is an explicit null;
 * falsy values (0 and false) are preserved.
 */
export function extractHistoricalStudyRows(rows, requestedPlotIds) {
  if (!Array.isArray(rows)) throw new Error('Historical study rows are unavailable.');
  const seenTimes = new Set();
  const normalized = rows.map((row) => {
    if (!isRecord(row) || !isRecord(row.values)) throw new Error('Historical study row is malformed.');
    const time = validateUnixTime(row.time, 'Study row');
    if (seenTimes.has(time)) throw new Error(`Duplicate study timestamp: ${time}.`);
    seenTimes.add(time);

    const values = {};
    for (const plotId of requestedPlotIds) {
      const value = Object.prototype.hasOwnProperty.call(row.values, plotId)
        ? row.values[plotId]
        : null;
      values[plotId] = normalizeStudyValue(value, plotId, time);
    }
    return { time, values };
  });
  normalized.sort((a, b) => a.time - b.time);
  return normalized;
}

function normalizeOhlcvRow(row) {
  if (!isRecord(row)) throw new Error('OHLCV row is malformed.');
  const time = validateUnixTime(row.time, 'OHLCV row');
  for (const field of ['open', 'high', 'low', 'close']) {
    if (typeof row[field] !== 'number' || !Number.isFinite(row[field])) {
      throw new Error(`OHLCV ${field} at ${time} must be numeric.`);
    }
  }
  if (row.high < Math.max(row.open, row.close, row.low)) {
    throw new Error(`OHLCV high invariant failed at ${time}.`);
  }
  if (row.low > Math.min(row.open, row.close, row.high)) {
    throw new Error(`OHLCV low invariant failed at ${time}.`);
  }
  if (row.volume != null
    && (typeof row.volume !== 'number' || !Number.isFinite(row.volume) || row.volume < 0)) {
    throw new Error(`OHLCV volume at ${time} must be non-negative numeric or null.`);
  }
  return {
    time,
    open: row.open,
    high: row.high,
    low: row.low,
    close: row.close,
    volume: row.volume ?? null,
  };
}

/** Align OHLCV by exact native timestamps; never shifts rows by position. */
export function extractAlignedOhlcvRows(rows, studyRows) {
  if (!Array.isArray(rows)) throw new Error('Atomic OHLCV rows are unavailable.');
  const byTime = new Map();
  for (const row of rows) {
    if (!isRecord(row)) throw new Error('OHLCV row is malformed.');
    const time = validateUnixTime(row.time, 'OHLCV row');
    if (byTime.has(time)) throw new Error(`Duplicate OHLCV timestamp: ${time}.`);
    byTime.set(time, row);
  }

  return studyRows.map(({ time }) => {
    if (!byTime.has(time)) throw new Error(`Missing OHLCV row for study timestamp: ${time}.`);
    return normalizeOhlcvRow(byTime.get(time));
  });
}

function normalizeOhlcvRows(rows) {
  if (!Array.isArray(rows)) throw new Error('Atomic OHLCV rows are unavailable.');
  const normalized = [];
  const byTime = new Map();
  for (const row of rows) {
    const value = normalizeOhlcvRow(row);
    if (byTime.has(value.time)) throw new Error(`Duplicate OHLCV timestamp: ${value.time}.`);
    normalized.push(value);
    byTime.set(value.time, value);
  }
  normalized.sort((a, b) => a.time - b.time);
  return { normalized, byTime };
}

function validateAtomicSnapshot(snapshot) {
  if (!isRecord(snapshot.atomic_context)) {
    throw new Error('Atomic study history context is unavailable.');
  }
  const atomic = snapshot.atomic_context;
  if (atomic.runtime_read_count !== 1) {
    throw new Error('Atomic study history snapshot must use exactly one runtime read.');
  }
  if (atomic.synchronous !== true) {
    throw new Error('Atomic study history snapshot must be synchronous.');
  }
  if (atomic.same_active_chart_object !== true) {
    throw new Error('Active chart object changed during the atomic study history read.');
  }
  if (atomic.identity_stable !== true) {
    throw new Error('Chart identity was not stable during the atomic study history read.');
  }

  const identityBefore = validateChartIdentity(snapshot.identity_before);
  const identityAfter = validateChartIdentity(snapshot.identity_after);
  if (!chartIdentitiesEqual(identityBefore, identityAfter)) {
    throw new Error('Chart identity changed during the atomic study history read.');
  }
  const chart = validateChartIdentity(snapshot.chart);
  if (!chartIdentitiesEqual(chart, identityBefore)) {
    throw new Error('Atomic chart identity does not match the pre-read identity.');
  }
  return {
    chart,
    atomic_context: {
      runtime_read_count: atomic.runtime_read_count,
      synchronous: atomic.synchronous,
      same_active_chart_object: atomic.same_active_chart_object,
      identity_stable: atomic.identity_stable,
    },
  };
}

/**
 * Pure payload builder for one adapter snapshot. `snapshot.chart`,
 * `snapshot.studies`, and `snapshot.ohlcv_rows` must all originate from the
 * same synchronous Runtime read window; this function performs no fallback
 * reads and fails closed on ambiguity or malformed identity.
 */
export function buildStudyHistoryResult(snapshot, request) {
  const normalizedRequest = normalizeStudyHistoryRequest(request);
  if (!isRecord(snapshot)) throw new Error('Atomic study history snapshot is unavailable.');
  const { chart, atomic_context } = validateAtomicSnapshot(snapshot);
  if (!Array.isArray(snapshot.studies)) throw new Error('Study sources are unavailable in the atomic snapshot.');

  const matches = snapshot.studies.filter(study => (
    isRecord(study) && study.entity_id === normalizedRequest.entity_id
  ));
  if (matches.length === 0) throw new Error(`Study not found: ${normalizedRequest.entity_id}.`);
  if (matches.length > 1) throw new Error(`Multiple studies found for entity_id: ${normalizedRequest.entity_id}.`);

  const selectedStudy = matches[0];
  const metadata = extractStudyMetadata(selectedStudy, normalizedRequest.plot_ids);
  const loadedStudyRows = extractHistoricalStudyRows(selectedStudy.rows, normalizedRequest.plot_ids);

  let usableStudyRows = loadedStudyRows;
  let normalizedOhlcvRows = null;
  let alignedLoadedCount = null;
  if (normalizedRequest.include_ohlcv) {
    const normalizedOhlcv = normalizeOhlcvRows(snapshot.ohlcv_rows);
    normalizedOhlcvRows = normalizedOhlcv.normalized;
    usableStudyRows = loadedStudyRows.filter(row => normalizedOhlcv.byTime.has(row.time));
    alignedLoadedCount = usableStudyRows.length;
  } else if (Array.isArray(snapshot.ohlcv_rows)) {
    normalizedOhlcvRows = normalizeOhlcvRows(snapshot.ohlcv_rows).normalized;
  }

  const study_rows = usableStudyRows.slice(-normalizedRequest.count);
  let ohlcv_rows = null;
  if (normalizedRequest.include_ohlcv) {
    const selectedTimes = new Set(study_rows.map(row => row.time));
    ohlcv_rows = normalizedOhlcvRows.filter(row => selectedTimes.has(row.time));
  }
  const loadedCount = usableStudyRows.length;

  return {
    success: true,
    chart,
    atomic_context,
    study: metadata.study,
    plots: metadata.plots,
    study_rows,
    ohlcv_rows,
    history: {
      scope: 'currently_loaded_runtime_data',
      global_history_complete_known: false,
      study_loaded_count: loadedStudyRows.length,
      ohlcv_loaded_count: normalizedOhlcvRows?.length ?? null,
      aligned_loaded_count: alignedLoadedCount,
    },
    loaded_count: loadedCount,
    returned_count: study_rows.length,
    truncated: loadedCount > study_rows.length,
  };
}

/**
 * Read one complete active-chart snapshot in exactly one synchronous page-side
 * evaluation. All accesses in the IIFE are read-only; no history loading,
 * chart navigation, crosshair, or Data Window state is used.
 */
export async function readAtomicStudyHistorySnapshot(
  request,
  { runtimeEvaluate = evaluateSingleRuntimeRead } = {},
) {
  const normalizedRequest = normalizeStudyHistoryRequest(request);
  if (typeof runtimeEvaluate !== 'function') throw new Error('Single-read runtime evaluator is unavailable.');

  const snapshot = await runtimeEvaluate(`
    (function() {
      var entityId = ${safeString(normalizedRequest.entity_id)};
      var requestedPlotIds = ${JSON.stringify(normalizedRequest.plot_ids)};
      var activeChartBefore = ${CHART_API};
      if (!activeChartBefore || !activeChartBefore._chartWidget) {
        throw new Error('Active chart object is unavailable.');
      }

      function readIdentity(chart) {
        return {
          symbol: chart.symbol(),
          resolution: chart.resolution(),
          chart_type: chart.chartType()
        };
      }
      function identitiesEqual(left, right) {
        return left.symbol === right.symbol
          && left.resolution === right.resolution
          && left.chart_type === right.chart_type;
      }

      var identityBefore = readIdentity(activeChartBefore);
      var chartModel = activeChartBefore._chartWidget.model();
      var sources = chartModel.model().dataSources();
      if (!Array.isArray(sources)) throw new Error('Active chart data sources are unavailable.');

      var matches = [];
      for (var sourceIndex = 0; sourceIndex < sources.length; sourceIndex++) {
        var source = sources[sourceIndex];
        if (source && typeof source.id === 'function' && source.id() === entityId) {
          matches.push(source);
        }
      }
      if (matches.length === 0) throw new Error('Study not found: ' + entityId + '.');
      if (matches.length > 1) throw new Error('Multiple studies found for entity_id: ' + entityId + '.');

      var studies = [];
      for (var matchIndex = 0; matchIndex < matches.length; matchIndex++) {
        var study = matches[matchIndex];
        var inputs = study.inputs();
        var metaInfo = study.metaInfo();
        if (!inputs || typeof inputs !== 'object') throw new Error('Selected study inputs are unavailable.');
        if (!metaInfo || typeof metaInfo !== 'object') throw new Error('Selected study MetaInfo is unavailable.');
        if (!Array.isArray(metaInfo.plots)) throw new Error('Selected study plot metadata is unavailable.');

        var plots = [];
        var requestedOrdinals = [];
        for (var plotIndex = 0; plotIndex < metaInfo.plots.length; plotIndex++) {
          var metaPlot = metaInfo.plots[plotIndex];
          if (!metaPlot || typeof metaPlot !== 'object') throw new Error('Selected study plot metadata is malformed.');
          plots.push({
            ordinal: plotIndex,
            id: metaPlot.id,
            type: metaPlot.type == null ? null : metaPlot.type,
            target: metaPlot.target == null ? null : metaPlot.target,
            title: metaPlot.title == null ? null : metaPlot.title
          });
          for (var requestedIndex = 0; requestedIndex < requestedPlotIds.length; requestedIndex++) {
            if (metaPlot.id === requestedPlotIds[requestedIndex]) {
              requestedOrdinals[requestedIndex] = plotIndex;
            }
          }
        }

        var studyData = study.data();
        var plottableRange = studyData && studyData.plottableRange();
        var items = plottableRange && plottableRange._items;
        if (!Array.isArray(items)) throw new Error('Historical study rows are unavailable.');
        var rows = [];
        for (var itemIndex = 0; itemIndex < items.length; itemIndex++) {
          var item = items[itemIndex];
          var raw = item && item.value;
          if (!Array.isArray(raw)) throw new Error('Historical study row is malformed.');
          var values = Object.create(null);
          for (var valueIndex = 0; valueIndex < requestedPlotIds.length; valueIndex++) {
            var plotId = requestedPlotIds[valueIndex];
            var ordinal = requestedOrdinals[valueIndex];
            var rawValue = ordinal == null || raw.length <= ordinal + 1 ? null : raw[ordinal + 1];
            if (typeof rawValue === 'number' && !Number.isFinite(rawValue)) {
              throw new Error('Historical study value is not finite.');
            }
            values[plotId] = rawValue == null ? null : rawValue;
          }
          rows.push({ internal_index: item.index, time: raw[0], values: values });
        }

        studies.push({
          entity_id: study.id(),
          script_id: inputs.pineId == null ? null : inputs.pineId,
          pine_version: inputs.pineVersion == null ? null : String(inputs.pineVersion),
          description: metaInfo.description || metaInfo.shortDescription || null,
          meta_id: metaInfo.id == null ? null : metaInfo.id,
          meta_version: metaInfo.version == null ? null : metaInfo.version,
          plots: plots,
          rows: rows
        });
      }

      var bars = chartModel.mainSeries().bars();
      if (!bars || typeof bars.firstIndex !== 'function'
        || typeof bars.lastIndex !== 'function' || typeof bars.valueAt !== 'function') {
        throw new Error('Main-series OHLCV rows are unavailable.');
      }
      var ohlcvRows = [];
      var firstIndex = bars.firstIndex();
      var lastIndex = bars.lastIndex();
      for (var barIndex = firstIndex; barIndex <= lastIndex; barIndex++) {
        var rawBar = bars.valueAt(barIndex);
        if (!rawBar) continue;
        if (!Array.isArray(rawBar)) throw new Error('Main-series OHLCV row is malformed.');
        for (var priceIndex = 1; priceIndex <= 4; priceIndex++) {
          if (typeof rawBar[priceIndex] !== 'number' || !Number.isFinite(rawBar[priceIndex])) {
            throw new Error('Main-series OHLCV price is not finite numeric.');
          }
        }
        if (rawBar.length > 5 && rawBar[5] != null
          && (typeof rawBar[5] !== 'number' || !Number.isFinite(rawBar[5]))) {
          throw new Error('Main-series OHLCV volume is not finite numeric.');
        }
        ohlcvRows.push({
          time: rawBar[0],
          open: rawBar[1],
          high: rawBar[2],
          low: rawBar[3],
          close: rawBar[4],
          volume: rawBar.length > 5 && rawBar[5] != null ? rawBar[5] : null
        });
      }

      var activeChartAfter = ${CHART_API};
      var identityAfter = readIdentity(activeChartAfter);
      var sameActiveChartObject = activeChartBefore === activeChartAfter;
      var identityStable = identitiesEqual(identityBefore, identityAfter);
      return {
        chart: identityBefore,
        identity_before: identityBefore,
        identity_after: identityAfter,
        atomic_context: {
          runtime_read_count: 1,
          synchronous: true,
          same_active_chart_object: sameActiveChartObject,
          identity_stable: identityStable
        },
        studies: studies,
        ohlcv_rows: ohlcvRows
      };
    })()
  `);

  if (!isRecord(snapshot) || !Array.isArray(snapshot.studies)) {
    throw new Error('Atomic study history runtime snapshot is malformed.');
  }
  const matches = snapshot.studies.filter(study => (
    isRecord(study) && study.entity_id === normalizedRequest.entity_id
  ));
  if (matches.length !== 1) {
    throw new Error(matches.length === 0
      ? `Study not found: ${normalizedRequest.entity_id}.`
      : `Multiple studies found for entity_id: ${normalizedRequest.entity_id}.`);
  }
  requireBoundedId(matches[0].script_id, 'study.script_id');
  requireBoundedId(matches[0].pine_version, 'study.pine_version');
  buildStudyHistoryResult(snapshot, normalizedRequest);
  return snapshot;
}

export async function getStudyHistory(request, { readAtomicSnapshot = readAtomicStudyHistorySnapshot } = {}) {
  const normalizedRequest = normalizeStudyHistoryRequest(request);
  if (typeof readAtomicSnapshot !== 'function') throw new Error('Atomic study history reader is unavailable.');
  const snapshot = await readAtomicSnapshot(normalizedRequest);
  return buildStudyHistoryResult(snapshot, normalizedRequest);
}

export async function getIndicator({ entity_id }) {
  const data = await evaluate(`
    (function() {
      var api = ${CHART_API};
      var study = api.getStudyById(${safeString(entity_id)});
      if (!study) return { error: 'Study not found: ' + ${safeString(entity_id)} };
      var result = { name: null, inputs: null, visible: null };
      try { result.visible = study.isVisible(); } catch(e) {}
      try { result.inputs = study.getInputValues(); } catch(e) { result.inputs_error = e.message; }
      return result;
    })()
  `);

  if (data?.error) throw new Error(data.error);

  let inputs = data?.inputs;
  if (Array.isArray(inputs)) {
    inputs = inputs.filter(inp => {
      if (inp.id === 'text' && typeof inp.value === 'string' && inp.value.length > 200) return false;
      if (typeof inp.value === 'string' && inp.value.length > 500) return false;
      return true;
    });
  }
  return { success: true, entity_id, visible: data?.visible, inputs };
}

// #173: TradingView doesn't compute strategy report/orders until the Strategy
// Tester panel is opened — and never computes one for a hidden strategy.
// Ensure the panel is open (via bottomWidgetBar), unhide any hidden
// strategies, and wait for reportData to populate, so the strategy read tools
// work even when the panel started closed or the strategy was hidden.
// Returns { status, unhidden } — unhidden lists strategies made visible.
async function ensureStrategyTesterReady(maxWaitMs = 6000) {
  const unhidden = await evaluate(`
    (function() {
      ${FIND_STRATEGY_JS}
      try {
        var bwb = window.TradingView && window.TradingView.bottomWidgetBar;
        if (bwb && typeof bwb.showWidget === 'function') bwb.showWidget('backtesting');
      } catch (e) {}
      return unhideStrategies();
    })()
  `);
  const deadline = Date.now() + maxWaitMs;
  let status = 'timeout';
  while (Date.now() < deadline) {
    const ready = await evaluate(`
      (function() {
        ${FIND_STRATEGY_JS}
        var f = findStrategy();
        if (!f) return 'no-strategy';
        return f.report && f.report.performance ? 'ready' : 'pending';
      })()
    `);
    if (ready === 'ready' || ready === 'no-strategy') { status = ready; break; }
    await new Promise(r => setTimeout(r, 500));
  }
  return { status, unhidden: unhidden || [] };
}

export async function getStrategyResults() {
  const ready = await ensureStrategyTesterReady();
  const results = await evaluate(`
    (function() {
      ${FIND_STRATEGY_JS}
      try {
        var found = findStrategy();
        if (!found) return {metrics: {}, source: 'internal_api', error: 'No strategy found on chart. Add a strategy first (e.g. indicator_add with a "... Strategy" script).'};
        var rd = found.report;
        if (!rd || !rd.performance) return {metrics: {}, source: 'internal_api', error: 'Strategy report not computed yet. Retry in a few seconds; if it persists, check the Strategy Tester panel is open (ui_open_panel strategy-tester) and the strategy is not hidden on the chart.'};
        var perf = rd.performance;
        var all = perf.all || {};
        // Headline metrics, named to match the Strategy Tester "Key stats".
        var metrics = {
          net_profit: all.netProfit,
          net_profit_percent: all.netProfitPercent,
          gross_profit: all.grossProfit,
          gross_loss: all.grossLoss,
          profit_factor: all.profitFactor,
          max_drawdown: perf.maxStrategyDrawDown,
          max_drawdown_percent: perf.maxStrategyDrawDownPercent,
          total_trades: (all.numberOfWiningTrades || 0) + (all.numberOfLosingTrades || 0),
          winning_trades: all.numberOfWiningTrades,
          losing_trades: all.numberOfLosingTrades,
          percent_profitable: all.percentProfitable,
          avg_trade: all.avgTrade,
          largest_win: all.largestWinTrade,
          largest_loss: all.largestLosTrade,
          commission_paid: all.commissionPaid,
          sharpe_ratio: perf.sharpeRatio,
          sortino_ratio: perf.sortinoRatio,
          buy_hold_return: perf.buyHoldReturn,
          open_pl: perf.openPL
        };
        var clean = {};
        for (var k in metrics) { if (metrics[k] !== null && metrics[k] !== undefined) clean[k] = metrics[k]; }
        var currency = rd.currency || null;
        return {metrics: clean, currency: currency, strategy: found.name, source: 'internal_api'};
      } catch(e) { return {metrics: {}, source: 'internal_api', error: e.message}; }
    })()
  `);
  return {
    success: Object.keys(results?.metrics || {}).length > 0,
    metric_count: Object.keys(results?.metrics || {}).length,
    strategy: results?.strategy, currency: results?.currency, source: results?.source,
    metrics: results?.metrics || {},
    ...(ready.unhidden.length && { unhidden_strategies: ready.unhidden, note: 'Strategy was hidden on the chart; it was made visible so the report could compute.' }),
    error: results?.error,
  };
}

export async function getTrades({ max_trades } = {}) {
  const limit = Math.min(max_trades || 20, MAX_TRADES);
  const ready = await ensureStrategyTesterReady();
  const trades = await evaluate(`
    (function() {
      ${FIND_STRATEGY_JS}
      try {
        var found = findStrategy();
        if (!found) return {trades: [], source: 'internal_api', error: 'No strategy found on chart.'};
        var strat = found.strat;
        var orders = strat.ordersData(); if (orders && typeof orders.value === 'function') orders = orders.value();
        if (!orders || !Array.isArray(orders)) return {trades: [], source: 'internal_api', total_orders: 0, error: 'Strategy orders not computed yet. Open the Strategy Tester panel (ui_open_panel strategy-tester) and retry.'};
        var total = orders.length;
        // Return the most RECENT orders (tail) — that's what a trader wants to see.
        var start = Math.max(0, total - ${limit});
        var result = [];
        for (var t = start; t < total; t++) {
          var o = orders[t];
          if (typeof o === 'object' && o !== null) {
            // Map TradingView's terse order keys to readable names.
            result.push({
              id: o.id,
              type: o.tp,
              side: o.b ? 'buy' : 'sell',
              entry: o.e,
              price: o.p,
              qty: o.q,
              time_index: o.tm
            });
          }
        }
        return {trades: result, total_orders: total, source: 'internal_api'};
      } catch(e) { return {trades: [], source: 'internal_api', error: e.message}; }
    })()
  `);
  return {
    success: (trades?.trades?.length || 0) > 0,
    trade_count: trades?.trades?.length || 0, total_orders: trades?.total_orders ?? 0,
    source: trades?.source, trades: trades?.trades || [],
    ...(ready.unhidden.length && { unhidden_strategies: ready.unhidden, note: 'Strategy was hidden on the chart; it was made visible so orders could compute.' }),
    error: trades?.error,
  };
}

export async function getEquity() {
  const ready = await ensureStrategyTesterReady();
  const equity = await evaluate(`
    (function() {
      ${FIND_STRATEGY_JS}
      try {
        var found = findStrategy();
        if (!found) return {data: [], source: 'internal_api', error: 'No strategy found on chart.'};
        var rd = found.report;
        if (!rd) return {data: [], source: 'internal_api', error: 'Strategy report not computed yet. Open the Strategy Tester panel and retry.'};
        // buyHold is the per-bar account curve; the equity curve is built from
        // filledOrders' cumulative P&L in reportData.
        var curve = rd.equity || rd.equityChart || null;
        if (Array.isArray(curve)) return {data: curve, source: 'internal_api'};
        if (Array.isArray(rd.buyHold)) {
          return {data: [], buy_hold_points: rd.buyHold.length, source: 'internal_api',
                  note: 'Per-bar equity curve not exposed directly; buyHold baseline has ' + rd.buyHold.length + ' points. Use data_get_strategy_results for summary P&L.'};
        }
        return {data: [], source: 'internal_api', note: 'Equity curve not available via API; use data_get_strategy_results.'};
      } catch(e) { return {data: [], source: 'internal_api', error: e.message}; }
    })()
  `);
  return {
    success: (equity?.data?.length || 0) > 0,
    data_points: equity?.data?.length || 0, source: equity?.source, data: equity?.data || [],
    buy_hold_points: equity?.buy_hold_points, note: equity?.note,
    ...(ready.unhidden.length && { unhidden_strategies: ready.unhidden }),
    error: equity?.error,
  };
}

export async function getQuote({ symbol } = {}) {
  // Serialize: chained on _quoteLock so parallel callers run one after another.
  // Catch on the lock chain prevents a single failure from poisoning the chain.
  const run = _quoteLock.then(() => _getQuoteInternal({ symbol }));
  _quoteLock = run.then(() => {}, () => {});
  return run;
}

async function _getQuoteInternal({ symbol } = {}) {
  const requested = (symbol || '').toString().trim();
  let originalSymbol = null;
  let needsRestore = false;

  if (requested) {
    try { originalSymbol = await evaluate(`${CHART_API}.symbol()`); } catch (e) {}
    const bare = (s) => (s || '').toString().split(':').pop().toUpperCase();
    if (bare(originalSymbol) !== bare(requested)) {
      needsRestore = true;
      await evaluateAsync(`
        (function() {
          var chart = ${CHART_API};
          return new Promise(function(resolve) {
            chart.setSymbol(${safeString(requested)}, {});
            setTimeout(resolve, 500);
          });
        })()
      `);
      await waitForChartReady(requested);
    }
  }

  try {
    const data = await evaluate(`
      (function() {
        var api = ${CHART_API};
        var sym = '';
        try { sym = api.symbol(); } catch(e) {}
        if (!sym) { try { sym = api.symbolExt().symbol; } catch(e) {} }
        var ext = {};
        try { ext = api.symbolExt() || {}; } catch(e) {}
        var bars = ${BARS_PATH};
        var quote = { symbol: sym };
        if (bars && typeof bars.lastIndex === 'function') {
          var last = bars.valueAt(bars.lastIndex());
          if (last) { quote.time = last[0]; quote.open = last[1]; quote.high = last[2]; quote.low = last[3]; quote.close = last[4]; quote.last = last[4]; quote.volume = last[5] || 0; }
        }
        try {
          var bidEl = document.querySelector('[class*="bid"] [class*="price"], [class*="dom-"] [class*="bid"]');
          var askEl = document.querySelector('[class*="ask"] [class*="price"], [class*="dom-"] [class*="ask"]');
          if (bidEl) quote.bid = parseFloat(bidEl.textContent.replace(/[^0-9.\\-]/g, ''));
          if (askEl) quote.ask = parseFloat(askEl.textContent.replace(/[^0-9.\\-]/g, ''));
        } catch(e) {}
        try {
          var hdr = document.querySelector('[class*="headerRow"] [class*="last-"]');
          if (hdr) { var hdrPrice = parseFloat(hdr.textContent.replace(/[^0-9.\\-]/g, '')); if (!isNaN(hdrPrice)) quote.header_price = hdrPrice; }
        } catch(e) {}
        if (ext.description) quote.description = ext.description;
        if (ext.exchange) quote.exchange = ext.exchange;
        if (ext.type) quote.type = ext.type;
        return quote;
      })()
    `);
    if (!data || (!data.last && !data.close)) throw new Error('Could not retrieve quote. The chart may still be loading.');
    return { success: true, ...data };
  } finally {
    if (needsRestore && originalSymbol) {
      try {
        await evaluateAsync(`
          (function() {
            var chart = ${CHART_API};
            return new Promise(function(resolve) {
              chart.setSymbol(${safeString(originalSymbol)}, {});
              setTimeout(resolve, 500);
            });
          })()
        `);
        await waitForChartReady(originalSymbol);
      } catch (e) {}
    }
  }
}

export async function getDepth() {
  const data = await evaluate(`
    (function() {
      var domPanel = document.querySelector('[class*="depth"]')
        || document.querySelector('[class*="orderBook"]')
        || document.querySelector('[class*="dom-"]')
        || document.querySelector('[class*="DOM"]')
        || document.querySelector('[data-name="dom"]');
      if (!domPanel) return { found: false, error: 'DOM / Depth of Market panel not found.' };
      var bids = [], asks = [];
      var rows = domPanel.querySelectorAll('[class*="row"], tr');
      for (var i = 0; i < rows.length; i++) {
        var row = rows[i];
        var priceEl = row.querySelector('[class*="price"]');
        var sizeEl = row.querySelector('[class*="size"], [class*="volume"], [class*="qty"]');
        if (!priceEl) continue;
        var price = parseFloat(priceEl.textContent.replace(/[^0-9.\\-]/g, ''));
        var size = sizeEl ? parseFloat(sizeEl.textContent.replace(/[^0-9.\\-]/g, '')) : 0;
        if (isNaN(price)) continue;
        var rowClass = row.className || '';
        var rowHTML = row.innerHTML || '';
        if (/bid|buy/i.test(rowClass) || /bid|buy/i.test(rowHTML)) bids.push({ price, size });
        else if (/ask|sell/i.test(rowClass) || /ask|sell/i.test(rowHTML)) asks.push({ price, size });
        else if (i < rows.length / 2) asks.push({ price, size });
        else bids.push({ price, size });
      }
      if (bids.length === 0 && asks.length === 0) {
        var cells = domPanel.querySelectorAll('[class*="cell"], td');
        var prices = [];
        cells.forEach(function(c) { var val = parseFloat(c.textContent.replace(/[^0-9.\\-]/g, '')); if (!isNaN(val) && val > 0) prices.push(val); });
        if (prices.length > 0) return { found: true, raw_values: prices.slice(0, 50), bids: [], asks: [], note: 'Could not classify bid/ask levels.' };
      }
      bids.sort(function(a, b) { return b.price - a.price; });
      asks.sort(function(a, b) { return a.price - b.price; });
      var spread = null;
      if (asks.length > 0 && bids.length > 0) spread = +(asks[0].price - bids[0].price).toFixed(6);
      return { found: true, bids: bids, asks: asks, spread: spread };
    })()
  `);

  if (!data || !data.found) throw new Error(data?.error || 'DOM panel not found.');
  return { success: true, bid_levels: data.bids?.length || 0, ask_levels: data.asks?.length || 0, spread: data.spread, bids: data.bids || [], asks: data.asks || [], raw_values: data.raw_values, note: data.note };
}

// Pure, read-only extraction of {id, name, inputs, values} from a raw
// dataSources() array. Kept dependency-free (no closures over outer scope)
// so it can run unmodified both here (unit tests, via direct import) and
// inside the page via `.toString()` injection in getStudyValues() below —
// the exact logic under test is what executes against the live chart.
//
// TradingView Desktop 3.3.0 changed the runtime shape of some data sources:
// source.metaInfo() can throw or return nothing even though the source is a
// real study, while `_studyMetaInfo` still carries description/id/inputs.
// metaInfo() is tried first (legacy path, unchanged behavior); `_studyMetaInfo`
// is only consulted as a fallback when metaInfo() is unusable. Values are
// still read from dataWindowView().items() first; valuesProvider /
// legendValuesProvider are only used as a last resort, and only when their
// resolved shape matches a recognized items-list (title/value pairs) — an
// unrecognized shape is skipped rather than guessed at.
export function buildStudyResults(sources) {
  function resolveMeta(s) {
    var meta = null;
    if (typeof s.metaInfo === 'function') {
      try { meta = s.metaInfo(); } catch (e) { meta = null; }
    }
    if (meta && (meta.description || meta.shortDescription)) return meta;
    var fallback = null;
    try { fallback = s._studyMetaInfo; } catch (e) { fallback = null; }
    if (typeof fallback === 'function') {
      try { fallback = fallback(); } catch (e) { fallback = null; }
    }
    if (fallback && (fallback.description || fallback.shortDescription)) return fallback;
    return null;
  }

  function valuesFromItems(items) {
    var values = {};
    if (!items) return values;
    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      if (!item) continue;
      var title = item._title != null ? item._title : item.title;
      var value = item._value != null ? item._value : item.value;
      var hasTitle = title != null && title !== '';
      var hasValue = value != null && value !== '' && value !== '∅';
      if (hasTitle && hasValue) values[title] = value;
    }
    return values;
  }

  function itemsFromCandidate(candidate) {
    if (candidate && typeof candidate.value === 'function') {
      try { candidate = candidate.value(); } catch (e) { candidate = null; }
    }
    if (Array.isArray(candidate)) return candidate;
    if (candidate && typeof candidate.items === 'function') {
      try { var it = candidate.items(); return Array.isArray(it) ? it : null; } catch (e) { return null; }
    }
    return null;
  }

  function valuesFromProvider(s, providerName) {
    var raw = s[providerName];
    if (raw == null) return {};
    var resolved = raw;
    if (typeof raw === 'function') {
      try { resolved = raw.call(s); } catch (e) { resolved = null; }
    }
    return valuesFromItems(itemsFromCandidate(resolved));
  }

  var results = [];
  for (var si = 0; si < sources.length; si++) {
    var s = sources[si];
    var meta = resolveMeta(s);
    if (!meta) continue;
    var name = meta.description || meta.shortDescription || '';
    if (!name) continue;

    var values = {};
    try {
      var dwv = typeof s.dataWindowView === 'function' ? s.dataWindowView() : null;
      if (dwv) values = valuesFromItems(typeof dwv.items === 'function' ? dwv.items() : null);
    } catch (e) { values = {}; }

    if (Object.keys(values).length === 0) values = valuesFromProvider(s, 'valuesProvider');
    if (Object.keys(values).length === 0) values = valuesFromProvider(s, 'legendValuesProvider');
    if (Object.keys(values).length === 0) continue;

    // Include id + inputs so multiple instances of the same indicator
    // (e.g. two EMAs with different lengths) are distinguishable (#143).
    var id = null;
    try { id = typeof s.id === 'function' ? s.id() : null; } catch (e) {}
    var inputs = null;
    try {
      var ip = typeof s.inputs === 'function' ? s.inputs() : null;
      if (ip && Object.keys(ip).length) inputs = ip;
    } catch (e) {}

    results.push({ id: id, name: name, inputs: inputs, values: values });
  }
  return results;
}

export async function getStudyValues() {
  const data = await evaluate(`
    (function() {
      var chart = window.TradingViewApi._activeChartWidgetWV.value()._chartWidget;
      var model = chart.model();
      var sources = model.model().dataSources();
      return (${buildStudyResults.toString()})(sources);
    })()
  `);
  return { success: true, study_count: data?.length || 0, studies: data || [] };
}

export async function getPineLines({ study_filter, verbose } = {}) {
  const filter = study_filter || '';
  const raw = await evaluate(buildGraphicsJS('dwglines', 'lines', filter));
  if (!raw || raw.length === 0) return { success: true, study_count: 0, studies: [] };

  const studies = raw.map(s => {
    const hLevels = [];
    const seen = {};
    const allLines = [];
    for (const item of s.items) {
      const v = item.raw;
      const y1 = roundPrice(v.y1);
      const y2 = roundPrice(v.y2);
      if (verbose) allLines.push({ id: item.id, y1, y2, x1: v.x1, x2: v.x2, horizontal: v.y1 === v.y2, style: v.st, width: v.w, color: v.ci });
      if (y1 != null && v.y1 === v.y2 && !seen[y1]) { hLevels.push(y1); seen[y1] = true; }
    }
    hLevels.sort((a, b) => b - a);
    const result = { name: s.name, total_lines: s.count, horizontal_levels: hLevels };
    if (verbose) result.all_lines = allLines;
    return result;
  });
  return { success: true, study_count: studies.length, studies };
}

export async function getPineLabels({ study_filter, max_labels, verbose } = {}) {
  const filter = study_filter || '';
  const raw = await evaluate(buildGraphicsJS('dwglabels', 'labels', filter));
  if (!raw || raw.length === 0) return { success: true, study_count: 0, studies: [] };

  const limit = max_labels || 50;
  const studies = raw.map(s => {
    let labels = s.items.map(item => {
      const v = item.raw;
      const text = v.t || '';
      const price = roundPrice(v.y);
      if (verbose) return { id: item.id, text, price, x: v.x, yloc: v.yl, size: v.sz, textColor: v.tci, color: v.ci };
      return { text, price };
    }).filter(l => l.text || l.price != null);
    if (labels.length > limit) labels = labels.slice(-limit);
    return { name: s.name, total_labels: s.count, showing: labels.length, labels };
  });
  return { success: true, study_count: studies.length, studies };
}

export async function getPineTables({ study_filter } = {}) {
  const filter = study_filter || '';
  const raw = await evaluate(buildGraphicsJS('dwgtablecells', 'tableCells', filter));
  if (!raw || raw.length === 0) return { success: true, study_count: 0, studies: [] };

  const studies = raw.map(s => {
    const tables = {};
    for (const item of s.items) {
      const v = item.raw;
      const tid = v.tid || 0;
      if (!tables[tid]) tables[tid] = {};
      if (!tables[tid][v.row]) tables[tid][v.row] = {};
      tables[tid][v.row][v.col] = v.t || '';
    }
    const tableList = Object.entries(tables).map(([tid, rows]) => {
      const rowNums = Object.keys(rows).map(Number).sort((a, b) => a - b);
      const formatted = rowNums.map(rn => {
        const cols = rows[rn];
        const colNums = Object.keys(cols).map(Number).sort((a, b) => a - b);
        return colNums.map(cn => cols[cn]).filter(Boolean).join(' | ');
      }).filter(Boolean);
      return { rows: formatted };
    });
    return { name: s.name, tables: tableList };
  });
  return { success: true, study_count: studies.length, studies };
}

export async function getPineBoxes({ study_filter, verbose } = {}) {
  const filter = study_filter || '';
  const raw = await evaluate(buildGraphicsJS('dwgboxes', 'boxes', filter));
  if (!raw || raw.length === 0) return { success: true, study_count: 0, studies: [] };

  const studies = raw.map(s => {
    const zones = [];
    const seen = {};
    const allBoxes = [];
    for (const item of s.items) {
      const v = item.raw;
      const high = v.y1 != null && v.y2 != null ? roundPrice(Math.max(v.y1, v.y2)) : null;
      const low = v.y1 != null && v.y2 != null ? roundPrice(Math.min(v.y1, v.y2)) : null;
      if (verbose) allBoxes.push({ id: item.id, high, low, x1: v.x1, x2: v.x2, borderColor: v.c, bgColor: v.bc });
      if (high != null && low != null) { const key = high + ':' + low; if (!seen[key]) { zones.push({ high, low }); seen[key] = true; } }
    }
    zones.sort((a, b) => b.high - a.high);
    const result = { name: s.name, total_boxes: s.count, zones };
    if (verbose) result.all_boxes = allBoxes;
    return result;
  });
  return { success: true, study_count: studies.length, studies };
}
