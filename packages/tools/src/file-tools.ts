import { readFile, writeFile, readdir, stat, mkdir, unlink } from 'fs/promises';
import { resolve, relative, join } from 'path';
import { Sandbox } from './sandbox';

export class FileTools {
  constructor(private sandbox: Sandbox) {}

  async fileRead(
    args: { path: string; startLine?: number; endLine?: number },
    agentRoot?: string,
  ): Promise<string> {
    const allowed = agentRoot ? [agentRoot] : [];
    const absPath = this.sandbox.validatePath(args.path, allowed);
    try {
      const content = await readFile(absPath, 'utf-8');
      const lines = content.split('\n');
      if (args.startLine !== undefined || args.endLine !== undefined) {
        const start = (args.startLine || 1) - 1;
        const end = args.endLine || lines.length;
        return lines.slice(start, end).map((line, i) => `${start + i + 1}\t${line}`).join('\n');
      }
      return lines.map((line, i) => `${i + 1}\t${line}`).join('\n');
    } catch (err) {
      const msg = (err as Error).message;
      if (msg.includes('ENOENT')) throw new Error(`File not found: ${args.path}`);
      if (msg.includes('encoding') || msg.includes('invalid')) throw new Error(`Cannot read ${args.path} — it may be a binary file`);
      throw err;
    }
  }

  async fileWrite(
    args: { path: string; content: string },
    agentRoot?: string,
  ): Promise<string> {
    const allowed = agentRoot ? [agentRoot] : [];
    const absPath = this.sandbox.validatePath(args.path, allowed);
    const dir = resolve(absPath, '..');
    await mkdir(dir, { recursive: true });
    await writeFile(absPath, args.content, 'utf-8');
    return `Written ${args.content.length} bytes to ${args.path}`;
  }

  async fileDelete(args: { path: string }, agentRoot?: string): Promise<string> {
    const allowed = agentRoot ? [agentRoot] : [];
    const absPath = this.sandbox.validatePath(args.path, allowed);
    await unlink(absPath);
    return `Deleted ${args.path}`;
  }

  async fileSearch(args: { pattern: string }, agentRoot?: string): Promise<string> {
    const results: string[] = [];
    const root = agentRoot || this.sandbox.projectRoot;
    await this.walkDir(root, args.pattern, results, 0, 10);
    return results.join('\n') || 'No files found';
  }

  async fileGrep(
    args: { pattern: string; path?: string },
    agentRoot?: string,
  ): Promise<string> {
    const allowed = agentRoot ? [agentRoot] : [];
    const searchRoot = args.path
      ? this.sandbox.validatePath(args.path, allowed)
      : (agentRoot || this.sandbox.projectRoot);
    let regex: RegExp;
    try {
      regex = new RegExp(args.pattern);
    } catch (error) {
      return `Invalid regex pattern: ${error instanceof Error ? error.message : 'Unknown error'}`;
    }
    const results: string[] = [];
    await this.grepDir(searchRoot, regex, results, 0, 10);
    return results.join('\n') || 'No matches found';
  }

  async fileTree(
    args: { path?: string; depth?: number },
    agentRoot?: string,
  ): Promise<string> {
    const allowed = agentRoot ? [agentRoot] : [];
    const root = args.path
      ? this.sandbox.validatePath(args.path, allowed)
      : (agentRoot || this.sandbox.projectRoot);
    const maxDepth = args.depth || 3;
    const lines: string[] = [];
    await this.buildTree(root, '', lines, 0, maxDepth);
    return lines.join('\n');
  }

  // ─── Private helpers ──────────────────────────────────────────────────────

  private async walkDir(dir: string, pattern: string, results: string[], depth: number = 0, maxDepth: number = 10): Promise<void> {
    if (depth >= maxDepth) return;
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
        await this.walkDir(fullPath, pattern, results, depth + 1, maxDepth);
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

  private async grepDir(dir: string, regex: RegExp, results: string[], depth: number = 0, maxDepth: number = 10): Promise<void> {
    if (depth >= maxDepth) return;
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
        await this.grepDir(fullPath, regex, results, depth + 1, maxDepth);
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
