import { resolve, relative } from 'path';

export class ScopeTracker {
  private activeScopes: Map<string, string> = new Map(); // normalized scope → taskId
  private taskToScope: Map<string, string> = new Map();  // taskId → scope (for release)

  constructor(private projectRoot: string) {}

  private normalize(scope: string): string {
    if (!scope || !scope.trim()) throw new Error('Scope must not be empty');
    const abs = resolve(this.projectRoot, scope);
    const rel = relative(this.projectRoot, abs);
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
