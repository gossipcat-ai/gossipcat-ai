/**
 * _ast-walker-utils.ts — Shared AST walker helpers for signal-pipeline tests.
 *
 * Exported from here and imported by:
 *   - completion-signals-parity.test.ts  (Layer 1 drift guard)
 *   - ast-walker-bypass-hardening.test.ts (Gap 1–4 fixture tests, PR A issue #192)
 *
 * All helpers mirror the patched production walker exactly so that the tests
 * exercise the real logic and not a diverging copy.
 */
import * as ts from 'typescript';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ExtractedSignal {
  name: string;
  line: number;
  column: number;
}

export interface ReflectionOffender {
  file: string;
  line: number;
  col: number;
  reason: string;
  raw: string;
}

// ---------------------------------------------------------------------------
// Reflection method set
// ---------------------------------------------------------------------------

/**
 * All (object, method) pairs whose return values expose symbol /
 * property-descriptor information and can be used to reach a symbol key.
 * Key format: `<object>.<method>`.
 */
export const REFLECTION_METHODS = new Set<string>([
  'Object.getOwnPropertySymbols',
  'Object.getOwnPropertyNames',
  'Object.getOwnPropertyDescriptors',
  'Reflect.ownKeys',
]);

// ---------------------------------------------------------------------------
// initializerInvolvesGetOwnPropertySymbols
// ---------------------------------------------------------------------------

/**
 * Returns true when `node` is a call (or indexed call) to one of the
 * REFLECTION_METHODS — i.e. the direct form `<Object|Reflect>.<method>(x)`
 * or the indexed form `<Object|Reflect>.<method>(x)[N]`.
 */
export function initializerInvolvesGetOwnPropertySymbols(node: ts.Expression): boolean {
  let cur: ts.Node = node;
  if (ts.isElementAccessExpression(cur)) {
    cur = cur.expression;
  }
  if (!ts.isCallExpression(cur)) return false;
  const callee = cur.expression;
  if (!ts.isPropertyAccessExpression(callee)) return false;
  if (!ts.isIdentifier(callee.expression)) return false;
  const key = `${callee.expression.text}.${callee.name.text}`;
  return REFLECTION_METHODS.has(key);
}

// ---------------------------------------------------------------------------
// stripNonNull
// ---------------------------------------------------------------------------

/**
 * Strip a single layer of NonNullExpression (`expr!`) so that downstream
 * checks see the real expression kind.  Only one layer is stripped — double
 * non-null (`expr!!`) is an unusual pattern not worth recursing over.
 */
export function stripNonNull(expr: ts.Expression): ts.Expression {
  return ts.isNonNullExpression(expr) ? (expr.expression as ts.Expression) : expr;
}

// ---------------------------------------------------------------------------
// isChainedFromTracked
// ---------------------------------------------------------------------------

/**
 * Returns true when `init` is an expression that accesses a tracked binding
 * via ElementAccessExpression, PropertyAccessExpression `.at(...)`,
 * `.shift()`, or `.pop()`.  These are the "chained" forms that let an
 * attacker extract a single element out of a reflection-returned array.
 */
export function isChainedFromTracked(init: ts.Expression, tracked: Set<string>): boolean {
  const expr = stripNonNull(init);
  // `arr[0]` or `arr[sym]` — the object being indexed must be a tracked identifier.
  if (ts.isElementAccessExpression(expr)) {
    const obj = expr.expression;
    return ts.isIdentifier(obj) && tracked.has(obj.text);
  }
  // `arr.at(0)`, `arr.shift()`, `arr.pop()` — callee is PropAccess on tracked id.
  if (ts.isCallExpression(expr)) {
    const callee = expr.expression;
    if (ts.isPropertyAccessExpression(callee)) {
      const methodName = callee.name.text;
      if (methodName === 'at' || methodName === 'shift' || methodName === 'pop') {
        const obj = callee.expression;
        return ts.isIdentifier(obj) && tracked.has(obj.text);
      }
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// collectSymbolBindings
// ---------------------------------------------------------------------------

/**
 * Walk `sf` and return the set of all identifier names that are transitively
 * bound to a reflection-method result (Object.getOwnPropertySymbols, etc.).
 *
 * Pass 1 (seed): collect all variable declarations in a flat list.
 * Pass 2 (fixpoint): keep expanding `bound` until no new names are added,
 * propagating through element-access, .at()/.shift()/.pop(), simple aliases,
 * and computed-key destructuring.
 */
export function collectSymbolBindings(sf: ts.SourceFile): Set<string> {
  const bound = new Set<string>();

  interface VarDecl {
    node: ts.VariableDeclaration;
    init: ts.Expression;
  }
  const allDecls: VarDecl[] = [];

  function gatherDecls(node: ts.Node): void {
    if (ts.isVariableDeclaration(node) && node.initializer) {
      allDecls.push({ node, init: node.initializer });
    }
    ts.forEachChild(node, gatherDecls);
  }
  gatherDecls(sf);

  // --- Seed: declarations whose initializer is a direct reflection call.
  for (const { node, init } of allDecls) {
    if (ts.isIdentifier(node.name) && initializerInvolvesGetOwnPropertySymbols(init)) {
      bound.add(node.name.text);
    }
    // Gap 3: ObjectBindingPattern destructuring with a direct reflection call
    // initializer (unusual but complete).
    if (ts.isObjectBindingPattern(node.name)) {
      for (const el of node.name.elements) {
        const propName = el.propertyName;
        if (
          propName &&
          ts.isComputedPropertyName(propName) &&
          ts.isIdentifier(propName.expression) &&
          initializerInvolvesGetOwnPropertySymbols(init) &&
          ts.isIdentifier(el.name)
        ) {
          bound.add(el.name.text);
        }
      }
    }
    // F1: ArrayBindingPattern destructuring from a direct reflection call.
    // `const [sym] = Object.getOwnPropertySymbols(writer)` — each BindingElement
    // whose name is a plain Identifier (including rest elements `[...syms]`) is
    // seeded so the fixpoint can propagate through `syms[0]` chains.
    if (ts.isArrayBindingPattern(node.name) && initializerInvolvesGetOwnPropertySymbols(init)) {
      for (const el of node.name.elements) {
        if (ts.isBindingElement(el) && ts.isIdentifier(el.name)) {
          bound.add(el.name.text);
        }
      }
    }
  }

  // --- Fixpoint: propagate tracking through arbitrarily long chains.
  let changed = true;
  while (changed) {
    changed = false;
    for (const { node, init } of allDecls) {
      if (ts.isIdentifier(node.name) && !bound.has(node.name.text)) {
        // Chained element-access / .at() / .shift() / .pop() over a tracked binding.
        if (isChainedFromTracked(init, bound)) {
          bound.add(node.name.text);
          changed = true;
        }
        // Simple identifier alias: `const sym2 = sym;`
        // F2: strip a NonNullExpression layer first so `const sym2 = sym!`
        // resolves to the underlying identifier and is tracked correctly.
        const strippedInit = stripNonNull(init);
        if (ts.isIdentifier(strippedInit) && bound.has(strippedInit.text)) {
          bound.add(node.name.text);
          changed = true;
        }
      }
      // Gap 3: ObjectBindingPattern with computed key from a tracked symbol.
      // Pattern: `const { [sym]: internal } = someObj;`
      if (ts.isObjectBindingPattern(node.name)) {
        for (const el of node.name.elements) {
          const propName = el.propertyName;
          if (
            propName &&
            ts.isComputedPropertyName(propName) &&
            ts.isIdentifier(propName.expression) &&
            bound.has(propName.expression.text) &&
            ts.isIdentifier(el.name) &&
            !bound.has(el.name.text)
          ) {
            bound.add(el.name.text);
            changed = true;
          }
        }
      }
    }
  }

  return bound;
}

// ---------------------------------------------------------------------------
// scanReflectionBypass
// ---------------------------------------------------------------------------

/**
 * Walk a TypeScript source file and return every call site matching the
 * reflection-bypass pattern:
 *
 *   const sym = Object.getOwnPropertySymbols(<expr>)[<idx>];
 *   <writer>[sym].<method>(...);
 *   <writer>[sym](...);
 *
 * Handles the intermediate-variable binding case: first pass tracks the
 * names of variables initialised from any REFLECTION_METHODS call at any
 * depth in the same source file.  Second pass flags any CallExpression
 * whose callee is an ElementAccessExpression whose argumentExpression is an
 * Identifier whose name matches a tracked binding, OR whose callee is a
 * PropertyAccessExpression whose `.expression` is such an ElementAccess.
 */
export function scanReflectionBypass(
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
    // F1 rest-element: `writer[syms[0]](...)` — argument is a chained
    // ElementAccess/method-call whose root is a tracked binding (e.g. `syms`).
    if (arg && isChainedFromTracked(arg as ts.Expression, bound)) return true;
    return false;
  }

  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      const callee = node.expression;
      // Pattern A: writer[sym](...) or new writer[sym](...)
      if (isBypassElementAccess(callee)) {
        const pos = sf.getLineAndCharacterOfPosition(node.getStart(sf));
        offenders.push({
          file: fileLabel,
          line: pos.line + 1,
          col: pos.character + 1,
          reason: 'reflection-bypass call',
          raw: node.getText(sf).slice(0, 120),
        });
      } else if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(callee) && isBypassElementAccess(callee.expression)) {
        // Pattern B: writer[sym].method(...)
        const pos = sf.getLineAndCharacterOfPosition(node.getStart(sf));
        offenders.push({
          file: fileLabel,
          line: pos.line + 1,
          col: pos.character + 1,
          reason: 'reflection-bypass method call',
          raw: node.getText(sf).slice(0, 120),
        });
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);
  return offenders;
}

// ---------------------------------------------------------------------------
// extractSignalsFromHelper
// ---------------------------------------------------------------------------

/**
 * Parse a TypeScript source file at `filePath` and extract every string
 * literal assigned to a property named `signal` inside function bodies.
 *
 * Recursively visits all function-like nodes (FunctionDeclaration,
 * FunctionExpression, ArrowFunction, MethodDeclaration) anywhere in the
 * source file so that signals nested inside arrow functions, IIFE bodies, or
 * class methods are not missed.
 */
export function extractSignalsFromHelper(filePath: string): ExtractedSignal[] {
  const { readFileSync } = require('fs') as typeof import('fs');
  const source = readFileSync(filePath, 'utf8');
  return extractSignalsFromSource(filePath, source);
}

/**
 * Core implementation of the signal extractor — operates on a pre-parsed
 * source string so fixture tests can call it without touching the filesystem.
 */
export function extractSignalsFromSource(filePath: string, source: string): ExtractedSignal[] {
  const sf = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true);
  const found: ExtractedSignal[] = [];

  function isFunctionLike(
    node: ts.Node,
  ): node is ts.FunctionLikeDeclaration | ts.GetAccessorDeclaration | ts.SetAccessorDeclaration {
    return (
      ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isArrowFunction(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isGetAccessorDeclaration(node) ||
      ts.isSetAccessorDeclaration(node)
    );
  }

  function visitTopLevel(node: ts.Node): void {
    if (isFunctionLike(node) && node.body) {
      visit(node.body);
    } else {
      ts.forEachChild(node, visitTopLevel);
    }
  }

  for (const stmt of sf.statements) {
    visitTopLevel(stmt);
  }

  function visit(node: ts.Node): void {
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
    // Recurse into nested function-like nodes so deeply nested signals are
    // not missed (e.g. arrow callback inside a method).
    if (isFunctionLike(node) && node.body) {
      visit(node.body);
      return;
    }
    ts.forEachChild(node, visit);
  }

  return found;
}
