import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/pine.js';

export function registerPineTools(server) {
  server.tool('pine_get_bound_identity', 'Read the Pine editor binding from persistent platform identity signals. Returns UNPROVEN when identity cannot be established; visible title alone is never accepted.', {}, async () => {
    try { return jsonResult(await core.getBoundIdentity()); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('pine_get_source', 'Get current Pine Script source code from the editor', {}, async () => {
    try { return jsonResult(await core.getSource()); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('pine_set_source', 'Set Pine Script source code in the editor', {
    source: z.string().describe('Pine Script source code to inject'),
    expected_script_id: z.string().describe('Required persistent script ID; mutation stops if it is not the proven editor binding'),
  }, async ({ source, expected_script_id }) => {
    try {
      const result = await core.setSource({ source, expected_script_id });
      return jsonResult(result, result.success === false);
    }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('pine_compile', 'Compile / add the current Pine Script to the chart after a fail-closed identity check', {
    expected_script_id: z.string().describe('Required persistent script ID; compile may persist and stops on mismatch'),
  }, async ({ expected_script_id }) => {
    try {
      const result = await core.compile({ expected_script_id });
      return jsonResult(result, result.success === false);
    }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('pine_get_errors', 'Get Pine Script compilation errors from Monaco markers', {}, async () => {
    try { return jsonResult(await core.getErrors()); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('pine_save', 'Save the current Pine Script only when its persistent identity matches the expected ID', {
    expected_script_id: z.string().describe('Required persistent script ID; save stops on mismatch or protected ID'),
  }, async ({ expected_script_id }) => {
    try {
      const result = await core.save({ expected_script_id });
      return jsonResult(result, result.success === false);
    }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('pine_get_console', 'Read Pine Script console/log output (compile messages, log.info(), errors)', {}, async () => {
    try { return jsonResult(await core.getConsole()); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('pine_smart_compile', 'Intelligent compile with a fail-closed persistent identity check', {
    expected_script_id: z.string().describe('Required persistent script ID; compile stops on mismatch or protected ID'),
  }, async ({ expected_script_id }) => {
    try {
      const result = await core.smartCompile({ expected_script_id });
      return jsonResult(result, result.success === false);
    }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('pine_new', 'Request a new Pine Script and report success only after a new persistent identity is proven', {
    type: z.enum(['indicator', 'strategy', 'library']).describe('Type of script to create'),
    expected_script_id: z.string().describe('Required persistent ID bound before requesting the new script'),
  }, async ({ type, expected_script_id }) => {
    try {
      const result = await core.newScript({ type, expected_script_id });
      return jsonResult(result, result.success === false);
    }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('pine_open', 'Open a saved Pine Script and prove the editor is bound to its persistent ID', {
    name: z.string().optional().describe('Unique name of the saved script to open (case-insensitive)'),
    script_id: z.string().optional().describe('Persistent script ID to open; preferred over name'),
    expected_script_id: z.string().describe('Required persistent ID bound before navigation'),
  }, async ({ name, script_id, expected_script_id }) => {
    try {
      const result = await core.openScript({ name, script_id, expected_script_id });
      return jsonResult(result, result.success === false);
    }
    catch (err) { return jsonResult({ success: false, source: 'internal_api', error: err.message }, true); }
  });

  server.tool('pine_list_scripts', 'List saved Pine Scripts', {}, async () => {
    try { return jsonResult(await core.listScripts()); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('pine_analyze', 'Run static analysis on Pine Script code WITHOUT compiling — catches array out-of-bounds, unguarded array.first()/last(), bad loop bounds, and implicit bool casts. Works offline, no TradingView connection needed.', {
    source: z.string().describe('Pine Script source code to analyze'),
  }, async ({ source }) => {
    try { return jsonResult(core.analyze({ source })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('pine_check', 'Compile Pine Script via TradingView\'s server API without needing the chart open. Returns compilation errors/warnings. Useful for validating code before injecting into the chart.', {
    source: z.string().describe('Pine Script source code to compile/validate'),
  }, async ({ source }) => {
    try { return jsonResult(await core.check({ source })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });
}
