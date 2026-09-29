import { register } from '../router.js';
import * as core from '../../core/pine.js';
import { readFileSync } from 'fs';

async function readStdin() {
  if (process.stdin.isTTY) return null;
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf-8');
}

register('pine', {
  description: 'Pine Script tools',
  subcommands: new Map([
    ['identity', {
      description: 'Read the persistent identity currently bound to the Pine editor',
      handler: () => core.getBoundIdentity(),
    }],
    ['get', {
      description: 'Get current Pine Script source from editor',
      handler: () => core.getSource(),
    }],
    ['set', {
      description: 'Set Pine Script source (reads stdin or --file)',
      options: {
        file: { type: 'string', short: 'f', description: 'Read source from file' },
        'expected-id': { type: 'string', description: 'Required persistent script ID bound to the editor' },
      },
      handler: async (opts) => {
        let source;
        if (opts.file) {
          source = readFileSync(opts.file, 'utf-8');
        } else {
          source = await readStdin();
        }
        if (!source) throw new Error('No source provided. Pipe source via stdin or use --file.');
        return core.setSource({ source, expected_script_id: opts['expected-id'] });
      },
    }],
    ['compile', {
      description: 'Smart compile: detect button, compile, check errors',
      options: {
        'expected-id': { type: 'string', description: 'Required persistent script ID bound to the editor' },
      },
      handler: (opts) => core.smartCompile({ expected_script_id: opts['expected-id'] }),
    }],
    ['raw-compile', {
      description: 'Click compile/add button without smart detection',
      options: {
        'expected-id': { type: 'string', description: 'Required persistent script ID bound to the editor' },
      },
      handler: (opts) => core.compile({ expected_script_id: opts['expected-id'] }),
    }],
    ['analyze', {
      description: 'Offline static analysis (no TradingView needed)',
      options: {
        file: { type: 'string', short: 'f', description: 'Read source from file' },
      },
      handler: async (opts) => {
        let source;
        if (opts.file) {
          source = readFileSync(opts.file, 'utf-8');
        } else {
          source = await readStdin();
        }
        if (!source) throw new Error('No source provided. Pipe source via stdin or use --file.');
        return core.analyze({ source });
      },
    }],
    ['check', {
      description: 'Server-side compile check (no chart needed)',
      options: {
        file: { type: 'string', short: 'f', description: 'Read source from file' },
      },
      handler: async (opts) => {
        let source;
        if (opts.file) {
          source = readFileSync(opts.file, 'utf-8');
        } else {
          source = await readStdin();
        }
        if (!source) throw new Error('No source provided. Pipe source via stdin or use --file.');
        return core.check({ source });
      },
    }],
    ['save', {
      description: 'Save the current Pine Script (Ctrl+S)',
      options: {
        'expected-id': { type: 'string', description: 'Required persistent script ID bound to the editor' },
      },
      handler: (opts) => core.save({ expected_script_id: opts['expected-id'] }),
    }],
    ['new', {
      description: 'Create a new blank Pine Script (indicator, strategy, library)',
      options: {
        'expected-id': { type: 'string', description: 'Required persistent script ID bound before creation' },
      },
      handler: (opts, positionals) => {
        const type = positionals[0] || 'indicator';
        return core.newScript({ type, expected_script_id: opts['expected-id'] });
      },
    }],
    ['open', {
      description: 'Open a saved Pine Script by name',
      options: {
        'script-id': { type: 'string', description: 'Persistent script ID to open instead of a name' },
        'expected-id': { type: 'string', description: 'Required persistent script ID bound before navigation' },
      },
      handler: (opts, positionals) => {
        if (!positionals[0] && !opts['script-id']) {
          throw new Error('Script name or --script-id required. Usage: tv pine open "My Script" --expected-id USER;...');
        }
        return core.openScript({
          name: positionals.join(' ') || undefined,
          script_id: opts['script-id'],
          expected_script_id: opts['expected-id'],
        });
      },
    }],
    ['list', {
      description: 'List saved Pine Scripts',
      handler: () => core.listScripts(),
    }],
    ['errors', {
      description: 'Get Pine Script compilation errors',
      handler: () => core.getErrors(),
    }],
    ['console', {
      description: 'Get Pine Script console/log output',
      handler: () => core.getConsole(),
    }],
  ]),
});
