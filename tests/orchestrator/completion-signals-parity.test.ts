/**
 * Layer 1 signal-pipeline drift guard.
 *
 * Parses packages/orchestrator/src/completion-signals.ts with the TypeScript
 * Compiler API (already a devDep; ts-morph is not installed and was flagged
 * rather than added unilaterally). Extracts every string literal assigned
 * to a property named `signal` inside the helper's exported function bodies,
 * then compares the set against the committed allowlist.
 *
 * A mismatch in EITHER direction fails — new signals must be allowlisted,
 * and removed signals must be pruned from the allowlist.
 */
import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';
import * as ts from 'typescript';
import {
  COMPLETION_SIGNAL_ALLOWLIST,
  EMISSION_PATHS,
} from '../../packages/orchestrator/src/completion-signals.allowlist';

const HELPER_PATH = join(
  __dirname,
  '../../packages/orchestrator/src/completion-signals.ts',
);

interface ExtractedSignal {
  name: string;
  line: number;
  column: number;
}

function extractSignalsFromHelper(filePath: string): ExtractedSignal[] {
  const source = readFileSync(filePath, 'utf8');
  const sf = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true);
  const found: ExtractedSignal[] = [];

  // Walk only named function declarations at module top-level. This scopes
  // extraction to the helper's own function bodies and ignores anything
  // imported or referenced from elsewhere.
  for (const stmt of sf.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.body) {
      visit(stmt.body);
    }
  }

  function visit(node: ts.Node): void {
    // Match: { signal: 'literal', ... }
    if (ts.isPropertyAssignment(node)) {
      const nameNode = node.name;
      const keyName = ts.isIdentifier(nameNode)
        ? nameNode.text
        : ts.isStringLiteral(nameNode)
          ? nameNode.text
          : undefined;
      if (keyName === 'signal' && ts.isStringLiteral(node.initializer)) {
        const pos = sf.getLineAndCharacterOfPosition(node.initializer.getStart(sf));
        found.push({
          name: node.initializer.text,
          line: pos.line + 1,
          column: pos.character + 1,
        });
      }
    }
    ts.forEachChild(node, visit);
  }

  return found;
}

/**
 * Walk a TypeScript source file and return every call site matching the
 * reflection-bypass pattern:
 *
 *   const sym = Object.getOwnPropertySymbols(<expr>)[<idx>];
 *   <writer>[sym].<method>(...);
 *   <writer>[sym](...);
 *
 * Handles the intermediate-variable binding case: first pass tracks the
 * names of variables initialised from `Object.getOwnPropertySymbols(...)` at
 * any depth in the same source file. Second pass flags any CallExpression
 * whose callee is an ElementAccessExpression whose argumentExpression is an
 * Identifier whose name matches a tracked binding, OR whose callee is a
 * PropertyAccessExpression whose `.expression` is such an ElementAccess.
 */
interface ReflectionOffender {
  file: string;
  line: number;
  col: number;
  reason: string;
  raw: string;
}

function collectSymbolBindings(sf: ts.SourceFile): Set<string> {
  const bound = new Set<string>();
  function visit(node: ts.Node): void {
    if (
      ts.isVariableDeclaration(node) &&
      node.initializer &&
      ts.isIdentifier(node.name)
    ) {
      if (initializerInvolvesGetOwnPropertySymbols(node.initializer)) {
        bound.add(node.name.text);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);
  return bound;
}

function initializerInvolvesGetOwnPropertySymbols(node: ts.Expression): boolean {
  // Match either the direct call `Object.getOwnPropertySymbols(x)` or the
  // indexed form `Object.getOwnPropertySymbols(x)[N]`.
  let cur: ts.Node = node;
  if (ts.isElementAccessExpression(cur)) {
    cur = cur.expression;
  }
  if (!ts.isCallExpression(cur)) return false;
  const callee = cur.expression;
  if (!ts.isPropertyAccessExpression(callee)) return false;
  if (!ts.isIdentifier(callee.expression)) return false;
  if (callee.expression.text !== 'Object') return false;
  return callee.name.text === 'getOwnPropertySymbols';
}

function scanReflectionBypass(
  sf: ts.SourceFile,
  fileLabel: string,
): ReflectionOffender[] {
  const bound = collectSymbolBindings(sf);
  const offenders: ReflectionOffender[] = [];

  function isBypassElementAccess(node: ts.Node): node is ts.ElementAccessExpression {
    if (!ts.isElementAccessExpression(node)) return false;
    const arg = node.argumentExpression;
    if (arg && ts.isIdentifier(arg) && bound.has(arg.text)) return true;
    // Also flag direct inlined form `writer[Object.getOwnPropertySymbols(writer)[0]]`.
    if (arg && initializerInvolvesGetOwnPropertySymbols(arg)) return true;
    return false;
  }

  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      // Pattern A: writer[sym](...)
      if (isBypassElementAccess(callee)) {
        const pos = sf.getLineAndCharacterOfPosition(node.getStart(sf));
        offenders.push({
          file: fileLabel,
          line: pos.line + 1,
          col: pos.character + 1,
          reason: 'reflection-bypass call via Object.getOwnPropertySymbols binding',
          raw: node.getText(sf).slice(0, 120),
        });
      } else if (ts.isPropertyAccessExpression(callee) && isBypassElementAccess(callee.expression)) {
        // Pattern B: writer[sym].method(...)
        const pos = sf.getLineAndCharacterOfPosition(node.getStart(sf));
        offenders.push({
          file: fileLabel,
          line: pos.line + 1,
          col: pos.character + 1,
          reason: 'reflection-bypass method call via Object.getOwnPropertySymbols binding',
          raw: node.getText(sf).slice(0, 120),
        });
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);
  return offenders;
}

/**
 * Find identifier bindings that reference WRITER_INTERNAL, including:
 *   import { WRITER_INTERNAL } from '...'
 *   import { WRITER_INTERNAL as Alias } from '...'
 *   export { WRITER_INTERNAL } from '...'
 *   export { WRITER_INTERNAL as Alias } from '...'
 *
 * Returns the local names under which the symbol is bound in this source file
 * (or the re-export alias names, for export-only files).
 */
function collectWriterInternalAliases(sf: ts.SourceFile): Set<string> {
  const aliases = new Set<string>();
  for (const stmt of sf.statements) {
    if (ts.isImportDeclaration(stmt) && stmt.importClause?.namedBindings) {
      const bindings = stmt.importClause.namedBindings;
      if (ts.isNamedImports(bindings)) {
        for (const el of bindings.elements) {
          // `propertyName` is the original name when there's an alias.
          // Without an alias, `propertyName` is undefined and `name` is both.
          const originalName = el.propertyName?.text ?? el.name.text;
          if (originalName === 'WRITER_INTERNAL') {
            aliases.add(el.name.text);
          }
        }
      }
    }
    if (ts.isExportDeclaration(stmt) && stmt.exportClause && ts.isNamedExports(stmt.exportClause)) {
      for (const el of stmt.exportClause.elements) {
        const originalName = el.propertyName?.text ?? el.name.text;
        if (originalName === 'WRITER_INTERNAL') {
          aliases.add(el.name.text);
        }
      }
    }
  }
  return aliases;
}

interface WriterInternalOffender {
  file: string;
  line: number;
  col: number;
  reason: string;
  raw: string;
}

function scanWriterInternalBypass(
  sf: ts.SourceFile,
  fileLabel: string,
): WriterInternalOffender[] {
  const aliases = collectWriterInternalAliases(sf);
  if (aliases.size === 0) return [];
  const offenders: WriterInternalOffender[] = [];

  function isAliasElementAccess(node: ts.Node): node is ts.ElementAccessExpression {
    if (!ts.isElementAccessExpression(node)) return false;
    const arg = node.argumentExpression;
    return !!arg && ts.isIdentifier(arg) && aliases.has(arg.text);
  }

  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (isAliasElementAccess(callee)) {
        const pos = sf.getLineAndCharacterOfPosition(node.getStart(sf));
        offenders.push({
          file: fileLabel,
          line: pos.line + 1,
          col: pos.character + 1,
          reason: 'WRITER_INTERNAL-alias bypass call',
          raw: node.getText(sf).slice(0, 120),
        });
      } else if (ts.isPropertyAccessExpression(callee) && isAliasElementAccess(callee.expression)) {
        const pos = sf.getLineAndCharacterOfPosition(node.getStart(sf));
        offenders.push({
          file: fileLabel,
          line: pos.line + 1,
          col: pos.character + 1,
          reason: 'WRITER_INTERNAL-alias method bypass call',
          raw: node.getText(sf).slice(0, 120),
        });
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);
  return offenders;
}

/**
 * Returns true if `node` is transitively inside a ClassDeclaration's
 * MethodDeclaration whose identifier text matches `methodName`. Uses AST
 * parent pointers only — no regex, no source-text inspection.
 */
function isInsideMethod(node: ts.Node, methodName: string): boolean {
  let cur: ts.Node | undefined = node.parent;
  while (cur) {
    if (ts.isMethodDeclaration(cur)) {
      const name = cur.name;
      if (name && ts.isIdentifier(name) && name.text === methodName) {
        // Confirm the method lives inside a ClassDeclaration, not an object literal.
        let p: ts.Node | undefined = cur.parent;
        while (p) {
          if (ts.isClassDeclaration(p)) return true;
          p = p.parent;
        }
        return false;
      }
      return false;
    }
    cur = cur.parent;
  }
  return false;
}

describe('completion-signals parity (Layer 1 drift guard)', () => {
  it('helper emissions exactly match COMPLETION_SIGNAL_ALLOWLIST', () => {
    const extracted = extractSignalsFromHelper(HELPER_PATH);
    const codeSet = new Set(extracted.map(s => s.name));
    const allowSet = new Set(COMPLETION_SIGNAL_ALLOWLIST);

    const addedInCode = [...codeSet].filter(s => !allowSet.has(s));
    const orphanedInAllowlist = [...allowSet].filter(s => !codeSet.has(s));

    if (addedInCode.length > 0 || orphanedInAllowlist.length > 0) {
      const lines: string[] = ['Signal allowlist drift detected:'];
      if (addedInCode.length > 0) {
        lines.push('  new signal added — update allowlist:');
        for (const name of addedInCode) {
          const locs = extracted
            .filter(s => s.name === name)
            .map(s => `completion-signals.ts:${s.line}:${s.column}`)
            .join(', ');
          lines.push(`    - ${name} (at ${locs})`);
        }
      }
      if (orphanedInAllowlist.length > 0) {
        lines.push('  signal removed — prune allowlist:');
        for (const name of orphanedInAllowlist) {
          lines.push(`    - ${name}`);
        }
      }
      throw new Error(lines.join('\n'));
    }

    expect(extracted.length).toBeGreaterThan(0);
    expect(codeSet).toEqual(allowSet);
  });

  it('every appendSignal(s) call site passes an EmissionPath second argument', () => {
    const repoRoot = join(__dirname, '../..');
    const scanRoots = [
      join(repoRoot, 'packages/orchestrator/src'),
      join(repoRoot, 'apps/cli/src'),
    ];
    const allowed = new Set<string>(EMISSION_PATHS);
    const offenders: Array<{ file: string; line: number; col: number; reason: string; raw: string }> = [];

    for (const root of scanRoots) {
      for (const file of walkTsFiles(root)) {
        scanFile(file);
      }
    }

    function walkTsFiles(dir: string): string[] {
      const out: string[] = [];
      let entries: string[] = [];
      try { entries = readdirSync(dir); } catch { return out; }
      for (const name of entries) {
        const full = join(dir, name);
        let st;
        try { st = statSync(full); } catch { continue; }
        if (st.isDirectory()) {
          out.push(...walkTsFiles(full));
        } else if (st.isFile() && (name.endsWith('.ts') || name.endsWith('.tsx')) && !name.endsWith('.d.ts')) {
          out.push(full);
        }
      }
      return out;
    }

    function scanFile(file: string): void {
      const source = readFileSync(file, 'utf8');
      const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
      const rel = relative(repoRoot, file);
      const isPerformanceWriter = rel.endsWith('packages/orchestrator/src/performance-writer.ts');
      visit(sf);

      function visit(node: ts.Node): void {
        if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
          const methodName = node.expression.name.text;
          if (methodName === 'appendSignal' || methodName === 'appendSignals') {
            // Narrow performance-writer.ts skip to method-scope: only
            // call sites inside the `recordConsensusRoundRetraction`
            // MethodDeclaration are exempt. All other methods in that
            // file remain subject to the parity check.
            if (isPerformanceWriter && isInsideMethod(node, 'recordConsensusRoundRetraction')) {
              return;
            }
            // L2: signal-helpers.ts is the sanctioned internal caller module.
            // It accesses appendSignal(s) via the WRITER_INTERNAL Symbol key and
            // passes typed emissionPath literals from EMISSION_PATHS — the AST
            // walker sees PropertyAccessExpression on the Symbol-keyed object,
            // which is a legitimate access. Skip this file at the call-site level;
            // the Step 4 import-boundary test (PR B) enforces WRITER_INTERNAL
            // is not imported outside the three sanctioned files.
            if (rel.endsWith('packages/orchestrator/src/signal-helpers.ts')) {
              return;
            }
            const args = node.arguments;
            if (args.length < 2) {
              const pos = sf.getLineAndCharacterOfPosition(node.getStart(sf));
              offenders.push({
                file: rel,
                line: pos.line + 1,
                col: pos.character + 1,
                reason: `${methodName}() called with ${args.length} argument(s); expected 2 (signals, emissionPath)`,
                raw: node.getText(sf).slice(0, 120),
              });
            } else {
              const second = args[1];
              if (!ts.isStringLiteral(second) && !ts.isNoSubstitutionTemplateLiteral(second)) {
                const pos = sf.getLineAndCharacterOfPosition(second.getStart(sf));
                offenders.push({
                  file: rel,
                  line: pos.line + 1,
                  col: pos.character + 1,
                  reason: `${methodName}() second argument is not a string literal`,
                  raw: second.getText(sf).slice(0, 80),
                });
              } else if (!allowed.has(second.text)) {
                const pos = sf.getLineAndCharacterOfPosition(second.getStart(sf));
                offenders.push({
                  file: rel,
                  line: pos.line + 1,
                  col: pos.character + 1,
                  reason: `${methodName}() second argument "${second.text}" is not in EMISSION_PATHS`,
                  raw: second.getText(sf).slice(0, 80),
                });
              }
            }
          }
        }
        ts.forEachChild(node, visit);
      }
    }

    if (offenders.length > 0) {
      const msg = [
        `Emission-path parity drift — ${offenders.length} offending appendSignal(s) call site(s).`,
        `Every call site under packages/orchestrator/src/ or apps/cli/src/ must pass a string literal`,
        `from EMISSION_PATHS in completion-signals.allowlist.ts as its second argument.`,
        '',
        ...offenders.map(o => `  ${o.file}:${o.line}:${o.col}  ${o.reason}\n    > ${o.raw}`),
      ].join('\n');
      throw new Error(msg);
    }
    expect(offenders).toEqual([]);
  });

  it('no reflection bypass on PerformanceWriter', () => {
    // Real-tree scan: no file under the scan roots may use
    // Object.getOwnPropertySymbols() to reach into a PerformanceWriter and
    // call internal methods, bypassing the emission-path contract.
    // signal-helpers.ts is the sanctioned surface and is exempt.
    const repoRoot = join(__dirname, '../..');
    const scanRoots = [
      join(repoRoot, 'apps/cli/src'),
      join(repoRoot, 'packages/orchestrator/src'),
    ];
    const exempt = new Set<string>([
      'packages/orchestrator/src/signal-helpers.ts',
    ]);
    const offenders: ReflectionOffender[] = [];

    function walkTsFiles(dir: string): string[] {
      const out: string[] = [];
      let entries: string[] = [];
      try { entries = readdirSync(dir); } catch { return out; }
      for (const name of entries) {
        const full = join(dir, name);
        let st;
        try { st = statSync(full); } catch { continue; }
        if (st.isDirectory()) {
          out.push(...walkTsFiles(full));
        } else if (st.isFile() && (name.endsWith('.ts') || name.endsWith('.tsx')) && !name.endsWith('.d.ts')) {
          out.push(full);
        }
      }
      return out;
    }

    for (const root of scanRoots) {
      for (const file of walkTsFiles(root)) {
        const rel = relative(repoRoot, file);
        if (exempt.has(rel)) continue;
        const source = readFileSync(file, 'utf8');
        const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
        offenders.push(...scanReflectionBypass(sf, rel));
      }
    }

    if (offenders.length > 0) {
      const msg = [
        `Reflection-bypass drift — ${offenders.length} offending call site(s).`,
        `No code outside signal-helpers.ts may reach into PerformanceWriter via`,
        `Object.getOwnPropertySymbols(). Route writes through the sanctioned helper path.`,
        '',
        ...offenders.map(o => `  ${o.file}:${o.line}:${o.col}  ${o.reason}\n    > ${o.raw}`),
      ].join('\n');
      throw new Error(msg);
    }
    expect(offenders).toEqual([]);

    // In-test fixture: verify the walker DOES flag the synthetic bypass
    // pattern. Parsed with ts.createSourceFile so the fixture lives in this
    // spec file without touching real source.
    const fixture = `
      declare const writer: any;
      const sym = Object.getOwnPropertySymbols(writer)[0];
      writer[sym].appendSignal({});
      writer[sym]({});
    `;
    const fixtureSf = ts.createSourceFile(
      'fixture-reflection.ts',
      fixture,
      ts.ScriptTarget.Latest,
      true,
    );
    const fixtureOffenders = scanReflectionBypass(fixtureSf, 'fixture-reflection.ts');
    expect(fixtureOffenders.length).toBeGreaterThanOrEqual(2);
    expect(fixtureOffenders.some(o => /reflection-bypass method call/.test(o.reason))).toBe(true);
    expect(fixtureOffenders.some(o => /^reflection-bypass call/.test(o.reason))).toBe(true);
  });

  it('no WRITER_INTERNAL alias-import or re-export bypass on PerformanceWriter', () => {
    // Real-tree scan: match `import { WRITER_INTERNAL as X }` and
    // `export { WRITER_INTERNAL as X }` and flag any subsequent
    // `writer[X](...)` / `writer[X].method(...)` call site.
    // signal-helpers.ts is the sanctioned surface and is exempt.
    const repoRoot = join(__dirname, '../..');
    const scanRoots = [
      join(repoRoot, 'apps/cli/src'),
      join(repoRoot, 'packages/orchestrator/src'),
    ];
    const exempt = new Set<string>([
      'packages/orchestrator/src/signal-helpers.ts',
      // The defining module itself re-exports WRITER_INTERNAL; call-site
      // scanning there is moot since any calls are internal implementation.
      'packages/orchestrator/src/_writer-internal.ts',
      // emitCompletionSignals is a sanctioned internal caller that writes
      // via the WRITER_INTERNAL accessor with a typed EmissionPath; it is
      // part of the Layer 1 sanctioned emit surface alongside signal-helpers.
      'packages/orchestrator/src/completion-signals.ts',
    ]);
    const offenders: WriterInternalOffender[] = [];

    function walkTsFiles(dir: string): string[] {
      const out: string[] = [];
      let entries: string[] = [];
      try { entries = readdirSync(dir); } catch { return out; }
      for (const name of entries) {
        const full = join(dir, name);
        let st;
        try { st = statSync(full); } catch { continue; }
        if (st.isDirectory()) {
          out.push(...walkTsFiles(full));
        } else if (st.isFile() && (name.endsWith('.ts') || name.endsWith('.tsx')) && !name.endsWith('.d.ts')) {
          out.push(full);
        }
      }
      return out;
    }

    for (const root of scanRoots) {
      for (const file of walkTsFiles(root)) {
        const rel = relative(repoRoot, file);
        if (exempt.has(rel)) continue;
        const source = readFileSync(file, 'utf8');
        const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
        offenders.push(...scanWriterInternalBypass(sf, rel));
      }
    }

    if (offenders.length > 0) {
      const msg = [
        `WRITER_INTERNAL-alias drift — ${offenders.length} offending call site(s).`,
        `No code outside signal-helpers.ts may import WRITER_INTERNAL (under any`,
        `alias) and call into the writer's internal surface.`,
        '',
        ...offenders.map(o => `  ${o.file}:${o.line}:${o.col}  ${o.reason}\n    > ${o.raw}`),
      ].join('\n');
      throw new Error(msg);
    }
    expect(offenders).toEqual([]);

    // In-test fixture: alias-import case.
    const aliasImportFixture = `
      import { WRITER_INTERNAL as Secret } from './_writer-internal';
      declare const writer: any;
      writer[Secret].appendSignal({});
      writer[Secret]({});
    `;
    const aliasSf = ts.createSourceFile(
      'fixture-alias-import.ts',
      aliasImportFixture,
      ts.ScriptTarget.Latest,
      true,
    );
    const aliasOffenders = scanWriterInternalBypass(aliasSf, 'fixture-alias-import.ts');
    expect(aliasOffenders.length).toBeGreaterThanOrEqual(2);

    // In-test fixture: re-export alias chain. The file re-exports
    // WRITER_INTERNAL under an alias and also exercises a bypass call
    // through the re-export alias itself.
    const reExportFixture = `
      export { WRITER_INTERNAL as Inner } from './_writer-internal';
      declare const writer: any;
      writer[Inner].appendSignal({});
    `;
    const reExportSf = ts.createSourceFile(
      'fixture-re-export.ts',
      reExportFixture,
      ts.ScriptTarget.Latest,
      true,
    );
    const reExportAliases = collectWriterInternalAliases(reExportSf);
    expect(reExportAliases.has('Inner')).toBe(true);
    const reExportOffenders = scanWriterInternalBypass(reExportSf, 'fixture-re-export.ts');
    expect(reExportOffenders.length).toBeGreaterThanOrEqual(1);

    // Plain (non-aliased) import should still be caught as the base case.
    const plainFixture = `
      import { WRITER_INTERNAL } from './_writer-internal';
      declare const writer: any;
      writer[WRITER_INTERNAL].appendSignal({});
    `;
    const plainSf = ts.createSourceFile(
      'fixture-plain-import.ts',
      plainFixture,
      ts.ScriptTarget.Latest,
      true,
    );
    const plainOffenders = scanWriterInternalBypass(plainSf, 'fixture-plain-import.ts');
    expect(plainOffenders.length).toBeGreaterThanOrEqual(1);
  });
});
