import { resolve, relative } from 'path';
import { realpathSync } from 'fs';

export class ScopeTracker {
  private activeScopes: Map<string, string> = new Map(); // normalized scope → taskId
  private taskToScope: Map<string, string> = new Map();  // taskId → scope (for release)

  constructor(private projectRoot: string, private siblingRoots: readonly string[] = []) {}

  private normalize(scope: string): string {
    if (!scope || !scope.trim()) throw new Error('Scope must not be empty');
    const realRoot = realpathSync(this.projectRoot);
    const abs = resolve(realRoot, scope);
    let real: string;
    try {
      real = realpathSync(abs);
    } catch {
      // Path doesn't exist yet (e.g. new directory) — fall back to resolve-only check
      real = abs;
    }
    // #520: a scope under an explicitly-declared sibling root is accepted. The
    // returned key is the canonical absolute path (unique per root, so the overlap
    // map in hasOverlap/register stays collision-free across roots). The too-broad
    // guard is recomputed PER-ROOT against the matched sibling, not against
    // projectRoot (consensus 56d65741 LOW finding).
    for (const s of this.siblingRoots) {
      let realSibling = s;
      try { realSibling = realpathSync(s); } catch { /* declared roots are realpath'd at config load; keep */ }
      const relS = relative(realSibling, real);
      if (relS === '') throw new Error(`Scope "${scope}" resolves to a sibling root — too broad`);
      if (!relS.startsWith('..') && !relS.startsWith('/') && relS !== '') {
        return real.endsWith('/') ? real : real + '/';
      }
    }
    const rel = relative(realRoot, real);
    if (rel.startsWith('..')) throw new Error(`Scope "${scope}" resolves outside project root`);
    if (rel === '') throw new Error(`Scope "${scope}" resolves to project root — too broad`);
    return rel.endsWith('/') ? rel : rel + '/';
  }

  hasOverlap(scope: string): { overlaps: boolean; conflictTaskId?: string; conflictScope?: string } {
    const normalized = this.normalize(scope);
    for (const [activeScope, taskId] of this.activeScopes) {
      if (normalized.startsWith(activeScope) || activeScope.startsWith(normalized)) {
        return { overlaps: true, conflictTaskId: taskId, conflictScope: activeScope };
      }
    }
    return { overlaps: false };
  }

  register(scope: string, taskId: string): void {
    const normalized = this.normalize(scope);
    this.activeScopes.set(normalized, taskId);
    this.taskToScope.set(taskId, normalized);
  }

  release(taskId: string): void {
    const scope = this.taskToScope.get(taskId);
    if (scope) {
      this.activeScopes.delete(scope);
      this.taskToScope.delete(taskId);
    }
  }

  getActiveScopeCount(): number {
    return this.activeScopes.size;
  }

  clear(): void {
    this.activeScopes.clear();
    this.taskToScope.clear();
  }
}
