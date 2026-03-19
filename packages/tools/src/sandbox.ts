import { resolve, dirname } from 'path';
import { existsSync, realpathSync } from 'fs';

export class Sandbox {
  private root: string;

  constructor(projectRoot: string) {
    this.root = realpathSync(resolve(projectRoot));
  }

  get projectRoot(): string { return this.root; }

  /**
   * Validate that a path resolves within the project root.
   * Handles non-existent files (for file_write) by walking up to the
   * deepest existing ancestor and resolving from there.
   * Resolves symlinks to prevent symlink escape attacks.
   */
  validatePath(filePath: string): string {
    // Resolve relative to project root
    const resolved = resolve(this.root, filePath);

    // Walk up to deepest existing ancestor (handles file_write to new paths)
    let checkPath = resolved;
    while (!existsSync(checkPath)) {
      const parent = dirname(checkPath);
      if (parent === checkPath) break; // filesystem root
      checkPath = parent;
    }

    const real = existsSync(checkPath) ? realpathSync(checkPath) : checkPath;
    const remainder = resolved.slice(checkPath.length);
    const fullReal = real + remainder;

    if (!fullReal.startsWith(this.root + '/') && fullReal !== this.root) {
      throw new Error(`Path "${filePath}" resolves outside project root`);
    }
    return resolved; // Return the resolved absolute path
  }
}
