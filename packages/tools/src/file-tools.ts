import { readFile, writeFile, readdir, stat, mkdir } from 'fs/promises';
import { resolve, relative, join } from 'path';
import { Sandbox } from './sandbox';

export class FileTools {
  constructor(private sandbox: Sandbox) {}

  async fileRead(args: { path: string; startLine?: number; endLine?: number }): Promise<string> {
    const absPath = this.sandbox.validatePath(args.path);
    const content = await readFile(absPath, 'utf-8');
    if (args.startLine !== undefined || args.endLine !== undefined) {
      const lines = content.split('\n');
      const start = (args.startLine || 1) - 1;
      const end = args.endLine || lines.length;
      return lines.slice(start, end).join('\n');
    }
    return content;
  }

  async fileWrite(args: { path: string; content: string }): Promise<string> {
    const absPath = this.sandbox.validatePath(args.path);
    const dir = resolve(absPath, '..');
    await mkdir(dir, { recursive: true });
    await writeFile(absPath, args.content, 'utf-8');
    return `Written ${args.content.length} bytes to ${args.path}`;
  }

  async fileSearch(args: { pattern: string }): Promise<string> {
    const results: string[] = [];
    await this.walkDir(this.sandbox.projectRoot, args.pattern, results);
    return results.join('\n') || 'No files found';
  }

  async fileGrep(args: { pattern: string; path?: string }): Promise<string> {
    const searchRoot = args.path
      ? this.sandbox.validatePath(args.path)
      : this.sandbox.projectRoot;
    const regex = new RegExp(args.pattern);
    const results: string[] = [];
    await this.grepDir(searchRoot, regex, results);
    return results.join('\n') || 'No matches found';
  }

  async fileTree(args: { path?: string; depth?: number }): Promise<string> {
    const root = args.path
      ? this.sandbox.validatePath(args.path)
      : this.sandbox.projectRoot;
    const maxDepth = args.depth || 3;
    const lines: string[] = [];
    await this.buildTree(root, '', lines, 0, maxDepth);
    return lines.join('\n');
  }

  // ─── Private helpers ──────────────────────────────────────────────────────

  private async walkDir(dir: string, pattern: string, results: string[]): Promise<void> {
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry === 'node_modules' || entry === '.git') continue;
      const fullPath = join(dir, entry);
      let info;
      try {
        info = await stat(fullPath);
      } catch {
        continue;
      }

      if (info.isDirectory()) {
        await this.walkDir(fullPath, pattern, results);
      } else {
        // Match glob-style pattern: convert * and ? to regex
        const regexStr = pattern
          .replace(/[.+^${}()|[\]\\]/g, '\\$&')
          .replace(/\*/g, '.*')
          .replace(/\?/g, '.');
        const regex = new RegExp(regexStr);
        const relPath = relative(this.sandbox.projectRoot, fullPath);
        if (regex.test(entry) || regex.test(relPath)) {
          results.push(relPath);
        }
      }
    }
  }

  private async grepDir(dir: string, regex: RegExp, results: string[]): Promise<void> {
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry === 'node_modules' || entry === '.git') continue;
      const fullPath = join(dir, entry);
      let info;
      try {
        info = await stat(fullPath);
      } catch {
        continue;
      }

      if (info.isDirectory()) {
        await this.grepDir(fullPath, regex, results);
      } else {
        try {
          const content = await readFile(fullPath, 'utf-8');
          const lines = content.split('\n');
          const relPath = relative(this.sandbox.projectRoot, fullPath);
          lines.forEach((line, idx) => {
            if (regex.test(line)) {
              results.push(`${relPath}:${idx + 1}: ${line}`);
            }
          });
        } catch {
          // Skip binary or unreadable files
        }
      }
    }
  }

  private async buildTree(
    dir: string,
    prefix: string,
    lines: string[],
    depth: number,
    maxDepth: number
  ): Promise<void> {
    if (depth >= maxDepth) return;

    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      return;
    }

    const filtered = entries.filter(e => e !== 'node_modules' && e !== '.git');

    for (let i = 0; i < filtered.length; i++) {
      const entry = filtered[i];
      const isLast = i === filtered.length - 1;
      const connector = isLast ? '└── ' : '├── ';
      const fullPath = join(dir, entry);

      let info;
      try {
        info = await stat(fullPath);
      } catch {
        continue;
      }

      lines.push(`${prefix}${connector}${entry}`);

      if (info.isDirectory()) {
        const childPrefix = prefix + (isLast ? '    ' : '│   ');
        await this.buildTree(fullPath, childPrefix, lines, depth + 1, maxDepth);
      }
    }
  }
}
