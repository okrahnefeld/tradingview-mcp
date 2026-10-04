/**
 * Offline guard: every JavaScript expression this codebase injects into a browser
 * page must still be valid JavaScript by the time it arrives.
 *
 * Injected code travels as a JS *template literal* in our source and is then handed
 * to Runtime.evaluate as a string. A template literal consumes backslash escapes
 * before anyone sees the result, which produces two failures that no amount of
 * reading the source catches:
 *
 *   `/(^|\s|-)primary-/`  ->  /(^|s|-)primary-/     parses fine, silently stops
 *                                                   matching anything space-separated
 *   `split(/[ \t\n]+/)`   ->  a raw newline inside a regex literal
 *                             ->  SyntaxError: Invalid regular expression
 *
 * Both of those shipped in this file's history. The first cost a failed live run that
 * looked like a missing DOM element; the second would have thrown in the page. So the
 * rule enforced here is blunt: payloads carry no backslash escapes, and every payload
 * must parse.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';

const SOURCES = ['../src/core/tab.js'];

/**
 * Extract the template literals passed to evalIn(...) / evaluate(...).
 * Deliberately simple: find the call, then take the backtick-delimited argument,
 * tracking nesting of `${ }` so an interpolation containing a backtick is survived.
 */
function injectedPayloads(src) {
  const payloads = [];
  const re = /\b(?:evalIn|evaluate)\(\s*`/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    let i = m.index + m[0].length;
    let depth = 0;
    let buf = '';
    while (i < src.length) {
      const ch = src[i];
      if (ch === '\\') { buf += src[i] + src[i + 1]; i += 2; continue; }
      if (ch === '$' && src[i + 1] === '{') { depth += 1; buf += '${'; i += 2; continue; }
      if (ch === '}' && depth > 0) { depth -= 1; buf += '}'; i += 1; continue; }
      if (ch === '`' && depth === 0) break;
      buf += ch;
      i += 1;
    }
    payloads.push({ index: m.index, raw: buf });
  }
  return payloads;
}

/** What the browser actually receives: template-literal escape processing applied. */
function asDelivered(raw) {
  // Substitute interpolations with a benign identifier so the result can be parsed.
  const substituted = raw.replace(/\$\{[^{}]*\}/g, 'document');
  // eslint-disable-next-line no-new-func
  return new Function(`return \`${substituted}\`;`)();
}

describe('injected browser expressions', () => {
  for (const rel of SOURCES) {
    const src = readFileSync(new URL(rel, import.meta.url), 'utf8');
    const payloads = injectedPayloads(src);

    it(`${rel}: finds payloads to check`, () => {
      assert.ok(payloads.length >= 5, `only found ${payloads.length} injected payloads`);
    });

    it(`${rel}: no payload carries a backslash escape`, () => {
      const offenders = payloads
        .filter(p => /\\./.test(p.raw))
        .map(p => `offset ${p.index}: ${/\\./.exec(p.raw)[0]}`);
      assert.deepEqual(offenders, [],
        'a backslash escape inside an injected payload is consumed by the template '
        + 'literal and never reaches the browser intact');
    });

    it(`${rel}: every payload is parseable JavaScript as delivered`, () => {
      for (const p of payloads) {
        let delivered;
        try {
          delivered = asDelivered(p.raw);
        } catch (e) {
          assert.fail(`payload at offset ${p.index} is not a valid template: ${e.message}`);
        }
        try {
          // eslint-disable-next-line no-new-func
          new Function(delivered);
        } catch (e) {
          assert.fail(`payload at offset ${p.index} does not parse as delivered: `
            + `${e.message}\n--- delivered ---\n${delivered.slice(0, 400)}`);
        }
      }
    });
  }
});

describe('the specific regressions that motivated this guard', () => {
  it('a \\s in a template literal collapses and stops matching', () => {
    const delivered = new Function('return `/(^|\\s|-)primary-/`;')();
    assert.equal(delivered, '/(^|s|-)primary-/');
    assert.equal(new RegExp('(^|s|-)primary-').test(' primary-LCiGJGSZ'), false);
  });

  it('a \\n in a template literal makes a regex literal unparseable', () => {
    const delivered = new Function('return `split(/[ \\t\\n]+/)`;')();
    assert.throws(() => new Function(delivered), SyntaxError);
  });

  it('classList token matching survives the round trip and is exact', () => {
    const cls = 'button-qM2OSl9- small-3N5nvfWy black-3eIOrpGN primary-LCiGJGSZ apply-o';
    const sec = 'button-qM2OSl9- small-3N5nvfWy gray-2_1Iqa8n secondary--jp1G1oF apply-';
    const isPrimary = (c) => c.split(' ').some(t => t.lastIndexOf('primary-', 0) === 0);
    assert.equal(isPrimary(cls), true);
    assert.equal(isPrimary(sec), false, 'secondary- must not be read as primary-');
  });
});
