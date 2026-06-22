/**
 * ast-walker-bypass-hardening.test.ts — Fixture tests for PR A (issue #192).
 *
 * Validates the four AST walker gaps patched in
 * tests/orchestrator/completion-signals-parity.test.ts:
 *
 *  Gap 1: initializerInvolvesGetOwnPropertySymbols — extended to recognise
 *          Reflect.ownKeys, Object.getOwnPropertyNames,
 *          Object.getOwnPropertyDescriptors in addition to
 *          Object.getOwnPropertySymbols.
 *
 *  Gap 2: collectSymbolBindings — chained-binding bypass:
 *          `const arr = Reflect.ownKeys(w); const sym = arr[0]; writer[sym](...);`
 *
 *  Gap 3: collectSymbolBindings — destructuring bypass:
 *          `const { [sym]: internal } = writer;`
 *
 *  Gap 4: extractSignalsFromHelper — recursively visits ALL function-like
 *          nodes (FunctionExpression, ArrowFunction, MethodDeclaration) not
 *          only top-level FunctionDeclaration.
 *
 * Each fixture provides:
 *   - A positive case that MUST be flagged by the scanner.
 *   - A negative control that MUST NOT be flagged.
 */
import * as ts from 'typescript';
import {
  collectSymbolBindings,
  ExtractedSignal,
  extractSignalsFromSource,
  scanReflectionBypass,
} from './_ast-walker-utils';

// ---------------------------------------------------------------------------
// Thin fixture wrappers
// ---------------------------------------------------------------------------

function parseSf(name: string, src: string): ts.SourceFile {
  return ts.createSourceFile(name, src, ts.ScriptTarget.Latest, true);
}

/** Patched implementation: delegates to the shared extractSignalsFromSource. */
function extractSignalsFromHelper_patched(src: string): ExtractedSignal[] {
  return extractSignalsFromSource('fixture.ts', src);
}

// ---------------------------------------------------------------------------
// Legacy-behavior-reference for regression comparison (Gap 4 negative control).
//
// This is the ONLY inline shim retained. It mirrors the pre-patch walker that
// only entered top-level FunctionDeclaration bodies and is used exclusively to
// prove the patched version extends coverage beyond what the original provided.
// Do NOT use this function in any new tests.
// ---------------------------------------------------------------------------
function extractSignalsFromHelper_original(src: string): ExtractedSignal[] {
  const filePath = 'fixture.ts';
  const sf = ts.createSourceFile(filePath, src, ts.ScriptTarget.Latest, true);
  const found: ExtractedSignal[] = [];
  for (const stmt of sf.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.body) { visit(stmt.body); }
  }
  function visit(node: ts.Node): void {
    if (ts.isPropertyAssignment(node)) {
      const nameNode = node.name;
      const keyName = ts.isIdentifier(nameNode) ? nameNode.text : ts.isStringLiteral(nameNode) ? nameNode.text : undefined;
      if (keyName === 'signal' && ts.isStringLiteral(node.initializer)) {
        const pos = sf.getLineAndCharacterOfPosition(node.initializer.getStart(sf));
        found.push({ name: node.initializer.text, line: pos.line + 1, column: pos.character + 1 });
      }
    }
    ts.forEachChild(node, visit);
  }
  return found;
}

// ===========================================================================
// Gap 1: initializerInvolvesGetOwnPropertySymbols — extended method set
// ===========================================================================
describe('Gap 1: reflection method set extended', () => {
  it('Reflect.ownKeys — seeds binding and flags downstream call', () => {
    const src = `
      declare const writer: any;
      const keys = Reflect.ownKeys(writer);
      const sym = keys[0];
      writer[sym]('data');
    `;
    const sf = parseSf('gap1-reflect-ownkeys.ts', src);
    const bound = collectSymbolBindings(sf);
    // `keys` is seeded because Reflect.ownKeys is a recognised method
    expect(bound.has('keys')).toBe(true);
    // `sym` is tracked through chained element access on a tracked binding
    expect(bound.has('sym')).toBe(true);
    const offenders = scanReflectionBypass(sf, 'gap1-reflect-ownkeys.ts');
    expect(offenders.length).toBeGreaterThanOrEqual(1);
  });

  it('Object.getOwnPropertyNames — seeds binding', () => {
    const src = `
      declare const writer: any;
      const names = Object.getOwnPropertyNames(writer);
      const sym = names[0];
      writer[sym].appendSignal({});
    `;
    const sf = parseSf('gap1-getOwnPropertyNames.ts', src);
    const bound = collectSymbolBindings(sf);
    expect(bound.has('names')).toBe(true);
    expect(bound.has('sym')).toBe(true);
    const offenders = scanReflectionBypass(sf, 'gap1-getOwnPropertyNames.ts');
    expect(offenders.length).toBeGreaterThanOrEqual(1);
  });

  it('Object.getOwnPropertyDescriptors — seeds binding', () => {
    const src = `
      declare const writer: any;
      const descs = Object.getOwnPropertyDescriptors(writer);
      const sym = Object.getOwnPropertyDescriptors(writer)[0];
      writer[sym]('x');
    `;
    const sf = parseSf('gap1-getOwnPropertyDescriptors.ts', src);
    const bound = collectSymbolBindings(sf);
    expect(bound.has('descs')).toBe(true);
    const offenders = scanReflectionBypass(sf, 'gap1-getOwnPropertyDescriptors.ts');
    expect(offenders.length).toBeGreaterThanOrEqual(1);
  });

  it('negative control: Object.keys does NOT seed a binding', () => {
    const src = `
      declare const writer: any;
      const keys = Object.keys(writer);
      const sym = keys[0];
      writer[sym]('data');
    `;
    const sf = parseSf('gap1-object-keys-control.ts', src);
    const bound = collectSymbolBindings(sf);
    // Object.keys is not in REFLECTION_METHODS — no seed
    expect(bound.has('keys')).toBe(false);
    expect(bound.has('sym')).toBe(false);
    const offenders = scanReflectionBypass(sf, 'gap1-object-keys-control.ts');
    expect(offenders).toEqual([]);
  });

  it('negative control: direct property access (not reflection) is not flagged', () => {
    const src = `
      declare const writer: any;
      const sym = writer.appendSignal;
      sym('data');
    `;
    const sf = parseSf('gap1-direct-prop-control.ts', src);
    const bound = collectSymbolBindings(sf);
    expect(bound.has('sym')).toBe(false);
    const offenders = scanReflectionBypass(sf, 'gap1-direct-prop-control.ts');
    expect(offenders).toEqual([]);
  });
});

// ===========================================================================
// Gap 2: chained-binding bypass
// ===========================================================================
describe('Gap 2: chained-binding bypass', () => {
  it('three-step chain via arr[0] is flagged', () => {
    // const arr = Object.getOwnPropertySymbols(w);
    // const sym = arr[0];
    // writer[sym](...);
    const src = `
      declare const writer: any;
      const arr = Object.getOwnPropertySymbols(writer);
      const sym = arr[0];
      writer[sym]('bypass');
    `;
    const sf = parseSf('gap2-chain-element-access.ts', src);
    const bound = collectSymbolBindings(sf);
    expect(bound.has('arr')).toBe(true);
    expect(bound.has('sym')).toBe(true);
    const offenders = scanReflectionBypass(sf, 'gap2-chain-element-access.ts');
    expect(offenders.length).toBeGreaterThanOrEqual(1);
    expect(offenders.some(o => /reflection-bypass call/.test(o.reason))).toBe(true);
  });

  it('.at() extraction is flagged', () => {
    const src = `
      declare const writer: any;
      const arr = Object.getOwnPropertySymbols(writer);
      const sym = arr.at(0)!;
      writer[sym].appendSignal({});
    `;
    const sf = parseSf('gap2-at-extraction.ts', src);
    const bound = collectSymbolBindings(sf);
    expect(bound.has('arr')).toBe(true);
    expect(bound.has('sym')).toBe(true);
    const offenders = scanReflectionBypass(sf, 'gap2-at-extraction.ts');
    expect(offenders.length).toBeGreaterThanOrEqual(1);
  });

  it('.shift() extraction is flagged', () => {
    const src = `
      declare const writer: any;
      const arr = Object.getOwnPropertySymbols(writer);
      const sym = arr.shift()!;
      writer[sym]('data');
    `;
    const sf = parseSf('gap2-shift-extraction.ts', src);
    const bound = collectSymbolBindings(sf);
    expect(bound.has('sym')).toBe(true);
    const offenders = scanReflectionBypass(sf, 'gap2-shift-extraction.ts');
    expect(offenders.length).toBeGreaterThanOrEqual(1);
  });

  it('.pop() extraction is flagged', () => {
    const src = `
      declare const writer: any;
      const arr = Object.getOwnPropertySymbols(writer);
      const sym = arr.pop()!;
      writer[sym]('data');
    `;
    const sf = parseSf('gap2-pop-extraction.ts', src);
    const bound = collectSymbolBindings(sf);
    expect(bound.has('sym')).toBe(true);
    const offenders = scanReflectionBypass(sf, 'gap2-pop-extraction.ts');
    expect(offenders.length).toBeGreaterThanOrEqual(1);
  });

  it('alias chain (sym2 = sym) is also flagged', () => {
    const src = `
      declare const writer: any;
      const arr = Object.getOwnPropertySymbols(writer);
      const sym = arr[0];
      const sym2 = sym;
      writer[sym2]('data');
    `;
    const sf = parseSf('gap2-alias-chain.ts', src);
    const bound = collectSymbolBindings(sf);
    expect(bound.has('arr')).toBe(true);
    expect(bound.has('sym')).toBe(true);
    expect(bound.has('sym2')).toBe(true);
    const offenders = scanReflectionBypass(sf, 'gap2-alias-chain.ts');
    expect(offenders.length).toBeGreaterThanOrEqual(1);
  });

  it('negative control: arr.find() is NOT treated as a tracked extraction', () => {
    // .find() is not in the allowlisted extraction methods (at/shift/pop)
    const src = `
      declare const writer: any;
      const arr = Object.getOwnPropertySymbols(writer);
      const sym = arr.find(() => true)!;
      writer[sym]('data');
    `;
    const sf = parseSf('gap2-find-control.ts', src);
    const bound = collectSymbolBindings(sf);
    // arr is seeded, but sym via .find() should NOT be tracked
    expect(bound.has('arr')).toBe(true);
    expect(bound.has('sym')).toBe(false);
    // Without sym in bound, the writer[sym] call won't be caught via binding
    // It still could be caught if the direct-inlined check fires, but `sym`
    // here is an identifier, not an inlined call, so no offender.
    const offenders = scanReflectionBypass(sf, 'gap2-find-control.ts');
    expect(offenders).toEqual([]);
  });

  it('negative control: unrelated arr[0] access is not flagged', () => {
    const src = `
      declare const arr: string[];
      const first = arr[0];
      console.log(first);
    `;
    const sf = parseSf('gap2-unrelated-array-control.ts', src);
    const bound = collectSymbolBindings(sf);
    expect(bound.has('arr')).toBe(false);
    expect(bound.has('first')).toBe(false);
    const offenders = scanReflectionBypass(sf, 'gap2-unrelated-array-control.ts');
    expect(offenders).toEqual([]);
  });
});

// ===========================================================================
// Gap 3: destructuring bypass
// ===========================================================================
describe('Gap 3: destructuring bypass', () => {
  it('computed-property destructuring from reflection result is flagged', () => {
    // const sym = Object.getOwnPropertySymbols(writer)[0];
    // const { [sym]: internal } = writer;
    // internal.appendSignal(...);
    const src = `
      declare const writer: any;
      const syms = Object.getOwnPropertySymbols(writer);
      const sym = syms[0];
      const { [sym]: internal } = writer;
      internal.appendSignal({});
    `;
    const sf = parseSf('gap3-destructure-bypass.ts', src);
    const bound = collectSymbolBindings(sf);
    expect(bound.has('syms')).toBe(true);
    expect(bound.has('sym')).toBe(true);
    // `internal` should be tracked because its destructuring key is a tracked symbol
    expect(bound.has('internal')).toBe(true);
  });

  it('chained destructuring then call is flagged by scanner', () => {
    const src = `
      declare const writer: any;
      const syms = Object.getOwnPropertySymbols(writer);
      const sym = syms[0];
      const { [sym]: internal } = writer;
      writer[internal]('bypass');
    `;
    const sf = parseSf('gap3-destructure-then-call.ts', src);
    const bound = collectSymbolBindings(sf);
    expect(bound.has('internal')).toBe(true);
    const offenders = scanReflectionBypass(sf, 'gap3-destructure-then-call.ts');
    expect(offenders.length).toBeGreaterThanOrEqual(1);
  });

  it('negative control: named destructuring (non-computed key) is not tracked', () => {
    // `const { appendSignal: fn } = writer;` — this uses a known, static
    // property name and is not a reflection bypass.
    const src = `
      declare const writer: any;
      const { appendSignal: fn } = writer;
      fn({});
    `;
    const sf = parseSf('gap3-named-destructure-control.ts', src);
    const bound = collectSymbolBindings(sf);
    expect(bound.has('fn')).toBe(false);
    // No reflection-bypass offenders expected for normal destructuring
    const offenders = scanReflectionBypass(sf, 'gap3-named-destructure-control.ts');
    expect(offenders).toEqual([]);
  });

  it('negative control: computed key from a non-tracked symbol is not marked', () => {
    const src = `
      const key = Symbol('myKey');
      declare const writer: any;
      const { [key]: internal } = writer;
      internal('x');
    `;
    const sf = parseSf('gap3-non-tracked-computed-control.ts', src);
    const bound = collectSymbolBindings(sf);
    // `key` is a Symbol() call, not a reflection method — not tracked
    expect(bound.has('key')).toBe(false);
    expect(bound.has('internal')).toBe(false);
    const offenders = scanReflectionBypass(sf, 'gap3-non-tracked-computed-control.ts');
    expect(offenders).toEqual([]);
  });
});

// ===========================================================================
// Gap 4: extractSignalsFromHelper — recursive function-like visitor
// ===========================================================================
describe('Gap 4: extractSignalsFromHelper visits nested function-like nodes', () => {
  it('signal inside an arrow function body is extracted', () => {
    const src = `
      export function emit() {
        const fn = () => {
          signals.push({ signal: 'task_completed', value: 1 });
        };
        fn();
      }
    `;
    const signals = extractSignalsFromHelper_patched(src);
    expect(signals.map(s => s.name)).toContain('task_completed');
  });

  it('signal inside a FunctionExpression is extracted', () => {
    const src = `
      export function emit() {
        const helper = function inner() {
          signals.push({ signal: 'format_compliance', value: 0 });
        };
        helper();
      }
    `;
    const signals = extractSignalsFromHelper_patched(src);
    expect(signals.map(s => s.name)).toContain('format_compliance');
  });

  it('signal inside a MethodDeclaration (class) is extracted', () => {
    const src = `
      class Emitter {
        emit() {
          signals.push({ signal: 'finding_dropped_format', value: 1 });
        }
      }
    `;
    const signals = extractSignalsFromHelper_patched(src);
    expect(signals.map(s => s.name)).toContain('finding_dropped_format');
  });

  it('deeply nested arrow inside arrow is extracted', () => {
    const src = `
      export function outer() {
        const mid = () => {
          const inner = () => {
            signals.push({ signal: 'task_tool_turns', value: 5 });
          };
          inner();
        };
        mid();
      }
    `;
    const signals = extractSignalsFromHelper_patched(src);
    expect(signals.map(s => s.name)).toContain('task_tool_turns');
  });

  it('negative control: original implementation misses top-level arrow/const signals', () => {
    // The original (pre-patch) walker only enters top-level FunctionDeclaration
    // bodies. A top-level `const emitter = () => { signal: 'x' }` is NOT a
    // FunctionDeclaration, so the original misses it.
    const src = `
      export const emitter = () => {
        signals.push({ signal: 'task_completed', value: 1 });
      };
    `;
    // Original: top-level variable holding an arrow function → not entered.
    const originalSignals = extractSignalsFromHelper_original(src);
    expect(originalSignals.map(s => s.name)).not.toContain('task_completed');

    // Patched: visitTopLevel recurses into the arrow function body → extracted.
    const patchedSignals = extractSignalsFromHelper_patched(src);
    expect(patchedSignals.map(s => s.name)).toContain('task_completed');
  });

  it('negative control: non-signal property assignment is not extracted', () => {
    const src = `
      export function emit() {
        const obj = { type: 'meta', agentId: 'x', taskId: 't1' };
      }
    `;
    const signals = extractSignalsFromHelper_patched(src);
    // No `signal:` key in the object — nothing should be extracted
    expect(signals).toEqual([]);
  });

  it('negative control: signal at module top-level (not in function) is ignored', () => {
    // The extractor only enters function bodies — module-level object literals
    // are ignored to prevent false positives from imported constants.
    const src = `
      const DEFAULTS = { signal: 'module_level', value: 0 };
    `;
    const signals = extractSignalsFromHelper_patched(src);
    // Not inside any function-like body → should not be extracted
    expect(signals.map(s => s.name)).not.toContain('module_level');
  });
});

// ===========================================================================
// F1: ArrayBindingPattern seed + rest element tracking (consensus finding)
// ===========================================================================
describe('F1: ArrayBindingPattern seed in reflection initializer', () => {
  it('array destructuring of reflection result is flagged (positive)', () => {
    // Bypass: `const [sym] = Object.getOwnPropertySymbols(writer); writer[sym](...)`
    const src = `
      declare const writer: any;
      const [sym] = Object.getOwnPropertySymbols(writer);
      writer[sym]('bypass');
    `;
    const sf = parseSf('f1-array-destructure-positive.ts', src);
    const bound = collectSymbolBindings(sf);
    // `sym` must be seeded from the ArrayBindingPattern
    expect(bound.has('sym')).toBe(true);
    const offenders = scanReflectionBypass(sf, 'f1-array-destructure-positive.ts');
    expect(offenders.length).toBeGreaterThanOrEqual(1);
    expect(offenders.some(o => /reflection-bypass/.test(o.reason))).toBe(true);
  });

  it('rest element in array destructuring of reflection result is flagged (positive)', () => {
    // Bypass: `const [...syms] = Object.getOwnPropertySymbols(writer); writer[syms[0]](...)`
    const src = `
      declare const writer: any;
      const [...syms] = Object.getOwnPropertySymbols(writer);
      writer[syms[0]]('bypass');
    `;
    const sf = parseSf('f1-rest-element-positive.ts', src);
    const bound = collectSymbolBindings(sf);
    // `syms` is seeded (rest element name); `syms[0]` is inlined in the call
    // so the direct isBypassElementAccess path fires via initializerInvolvesGetOwnPropertySymbols
    // OR through syms being tracked. Either way the call must be caught.
    expect(bound.has('syms')).toBe(true);
    const offenders = scanReflectionBypass(sf, 'f1-rest-element-positive.ts');
    expect(offenders.length).toBeGreaterThanOrEqual(1);
  });

  it('negative control: array destructuring of Object.keys is NOT flagged', () => {
    // Object.keys is not in REFLECTION_METHODS — no seed.
    const src = `
      declare const writer: any;
      const [val] = Object.keys(writer);
      writer[val]('data');
    `;
    const sf = parseSf('f1-object-keys-array-control.ts', src);
    const bound = collectSymbolBindings(sf);
    expect(bound.has('val')).toBe(false);
    const offenders = scanReflectionBypass(sf, 'f1-object-keys-array-control.ts');
    expect(offenders).toEqual([]);
  });
});

// ===========================================================================
// Batch B: constructor and accessor bypass patterns
// ===========================================================================
describe('Batch B: constructor and accessor bypass patterns', () => {
  it('(a) NewExpression element-access call is flagged', () => {
    // new PerformanceWriter(sym)[sym]('event')
    const src = `
      declare const writer: any;
      const sym = Object.getOwnPropertySymbols(writer)[0];
      new PerformanceWriter(sym)[sym]('event');
    `;
    const sf = parseSf('batchb-new-expression.ts', src);
    const bound = collectSymbolBindings(sf);
    expect(bound.has('sym')).toBe(true);
    const offenders = scanReflectionBypass(sf, 'batchb-new-expression.ts');
    expect(offenders.length).toBeGreaterThanOrEqual(1);
    expect(offenders.some(o => /reflection-bypass/.test(o.reason))).toBe(true);
  });

  it('(b) reflection bypass inside getter body is flagged', () => {
    const src = `
      declare const writer: any;
      class Foo {
        get bad() {
          const sym = Object.getOwnPropertySymbols(writer)[0];
          writer[sym]('event');
          return sym;
        }
      }
    `;
    const sf = parseSf('batchb-getter-bypass.ts', src);
    const offenders = scanReflectionBypass(sf, 'batchb-getter-bypass.ts');
    expect(offenders.length).toBeGreaterThanOrEqual(1);
    expect(offenders.some(o => /reflection-bypass/.test(o.reason))).toBe(true);
  });

  it('(c) reflection bypass inside setter body is flagged', () => {
    const src = `
      declare const writer: any;
      class Foo {
        set bad(v: any) {
          const sym = Object.getOwnPropertySymbols(writer)[0];
          writer[sym]('event');
        }
      }
    `;
    const sf = parseSf('batchb-setter-bypass.ts', src);
    const offenders = scanReflectionBypass(sf, 'batchb-setter-bypass.ts');
    expect(offenders.length).toBeGreaterThanOrEqual(1);
    expect(offenders.some(o => /reflection-bypass/.test(o.reason))).toBe(true);
  });

  it('(b-signal) signal inside getter body is extracted by extractSignalsFromSource', () => {
    const src = `
      class Foo {
        get bad() {
          signals.push({ signal: 'getter_bypass_signal', value: 1 });
          return 1;
        }
      }
    `;
    const extracted = extractSignalsFromHelper_patched(src);
    expect(extracted.map(s => s.name)).toContain('getter_bypass_signal');
  });

  it('(c-signal) signal inside setter body is extracted by extractSignalsFromSource', () => {
    const src = `
      class Foo {
        set bad(v: any) {
          signals.push({ signal: 'setter_bypass_signal', value: 1 });
        }
      }
    `;
    const extracted = extractSignalsFromHelper_patched(src);
    expect(extracted.map(s => s.name)).toContain('setter_bypass_signal');
  });

  it('negative control: new expression without reflection key is not flagged', () => {
    const src = `
      declare const writer: any;
      const result = new PerformanceWriter('literal')['knownMethod']('event');
    `;
    const sf = parseSf('batchb-new-no-reflection-control.ts', src);
    const offenders = scanReflectionBypass(sf, 'batchb-new-no-reflection-control.ts');
    expect(offenders).toEqual([]);
  });
});

// ===========================================================================
// F2: NonNull alias tracking (consensus finding)
// ===========================================================================
describe('F2: NonNull alias does not break tracking chain', () => {
  it('non-null alias chain is flagged (positive)', () => {
    // Bypass: arr[0]! aliased then aliased again with !
    const src = `
      declare const writer: any;
      const arr = Object.getOwnPropertySymbols(writer);
      const sym = arr[0]!;
      const sym2 = sym!;
      writer[sym2]('bypass');
    `;
    const sf = parseSf('f2-nonnull-alias-chain-positive.ts', src);
    const bound = collectSymbolBindings(sf);
    // arr seeded, sym via chained element access (stripNonNull on arr[0]!),
    // sym2 via F2 NonNull alias fix (sym! → sym)
    expect(bound.has('arr')).toBe(true);
    expect(bound.has('sym')).toBe(true);
    expect(bound.has('sym2')).toBe(true);
    const offenders = scanReflectionBypass(sf, 'f2-nonnull-alias-chain-positive.ts');
    expect(offenders.length).toBeGreaterThanOrEqual(1);
    expect(offenders.some(o => /reflection-bypass/.test(o.reason))).toBe(true);
  });
});

// ===========================================================================
// Batch C: object property hops
// ===========================================================================
describe('Batch C: object property hops', () => {
  it('(c1) longhand object literal seeding — property access on object is flagged', () => {
    // const o = { x: Object.getOwnPropertySymbols(writer)[0] }; writer[o.x]('event')
    const src = `
      declare const writer: any;
      const sym = Object.getOwnPropertySymbols(writer)[0];
      const o = { x: sym };
      writer[o.x]('event');
    `;
    const sf = parseSf('batchc-longhand-object.ts', src);
    const bound = collectSymbolBindings(sf);
    expect(bound.has('sym')).toBe(true);
    expect(bound.has('o')).toBe(true);
    const offenders = scanReflectionBypass(sf, 'batchc-longhand-object.ts');
    expect(offenders.length).toBeGreaterThanOrEqual(1);
  });

  it('(c2) shorthand object literal seeding — property access on object is flagged', () => {
    // const sym = ...; const o = { sym }; writer[o.sym]('event')
    const src = `
      declare const writer: any;
      const sym = Object.getOwnPropertySymbols(writer)[0];
      const o = { sym };
      writer[o.sym]('event');
    `;
    const sf = parseSf('batchc-shorthand-object.ts', src);
    const bound = collectSymbolBindings(sf);
    expect(bound.has('sym')).toBe(true);
    expect(bound.has('o')).toBe(true);
    const offenders = scanReflectionBypass(sf, 'batchc-shorthand-object.ts');
    expect(offenders.length).toBeGreaterThanOrEqual(1);
  });

  it('(c3) single-hop property access from tracked object is tracked and flagged', () => {
    // const sym = ...; const o = { x: sym }; const v = o.x; writer[v]('event')
    const src = `
      declare const writer: any;
      const sym = Object.getOwnPropertySymbols(writer)[0];
      const o = { x: sym };
      const v = o.x;
      writer[v]('event');
    `;
    const sf = parseSf('batchc-prop-access-hop.ts', src);
    const bound = collectSymbolBindings(sf);
    expect(bound.has('sym')).toBe(true);
    expect(bound.has('o')).toBe(true);
    expect(bound.has('v')).toBe(true);
    const offenders = scanReflectionBypass(sf, 'batchc-prop-access-hop.ts');
    expect(offenders.length).toBeGreaterThanOrEqual(1);
  });

  it('(c4) negative control: object with literal value is NOT flagged', () => {
    // const o = { x: 'literal' }; writer[o.x]('event') — no reflection source
    const src = `
      declare const writer: any;
      const o = { x: 'literal' };
      writer[o.x]('event');
    `;
    const sf = parseSf('batchc-literal-control.ts', src);
    const bound = collectSymbolBindings(sf);
    expect(bound.has('o')).toBe(false);
    const offenders = scanReflectionBypass(sf, 'batchc-literal-control.ts');
    expect(offenders).toEqual([]);
  });

  it('(c5) negative control: object with safe function call value is NOT flagged', () => {
    // const o = { x: safeFn() }; writer[o.x]('event') — no reflection source
    const src = `
      declare const writer: any;
      function safeFn() { return 'key'; }
      const o = { x: safeFn() };
      writer[o.x]('event');
    `;
    const sf = parseSf('batchc-safefn-control.ts', src);
    const bound = collectSymbolBindings(sf);
    expect(bound.has('o')).toBe(false);
    const offenders = scanReflectionBypass(sf, 'batchc-safefn-control.ts');
    expect(offenders).toEqual([]);
  });
});

// ===========================================================================
// Batch A: AwaitExpression / ParenthesizedExpression unwrap + IIFE fixtures
// ===========================================================================
describe('Batch A: IIFE and await bypass patterns', () => {
  it('(a) sync IIFE — reflection bypass inside sync IIFE is flagged', () => {
    const src = `
      declare const writer: any;
      (() => { const sym = Object.getOwnPropertySymbols(writer)[0]; writer[sym]('event'); })();
    `;
    const sf = parseSf('batcha-sync-iife.ts', src);
    const offenders = scanReflectionBypass(sf, 'batcha-sync-iife.ts');
    expect(offenders.length).toBeGreaterThanOrEqual(1);
  });

  it('(b) async IIFE — reflection bypass inside async IIFE with await is flagged', () => {
    const src = `
      declare const writer: any;
      (async () => { const sym = Object.getOwnPropertySymbols(writer)[0]; await writer[sym]('event'); })();
    `;
    const sf = parseSf('batcha-async-iife.ts', src);
    const offenders = scanReflectionBypass(sf, 'batcha-async-iife.ts');
    expect(offenders.length).toBeGreaterThanOrEqual(1);
  });

  it('(c) await chain — awaited reflection call seeds binding and downstream call is flagged', () => {
    const src = `
      declare const writer: any;
      const sym = await Object.getOwnPropertySymbols(writer);
      writer[sym[0]]('event');
    `;
    const sf = parseSf('batcha-await-chain.ts', src);
    const bound = collectSymbolBindings(sf);
    expect(bound.has('sym')).toBe(true);
    const offenders = scanReflectionBypass(sf, 'batcha-await-chain.ts');
    expect(offenders.length).toBeGreaterThanOrEqual(1);
  });

  it('(d) await inside async IIFE — awaited reflection call inside async IIFE is flagged', () => {
    const src = `
      declare const writer: any;
      (async () => { const sym = await Object.getOwnPropertySymbols(writer); writer[sym[0]]('event'); })();
    `;
    const sf = parseSf('batcha-await-iife.ts', src);
    const offenders = scanReflectionBypass(sf, 'batcha-await-iife.ts');
    expect(offenders.length).toBeGreaterThanOrEqual(1);
  });
});
