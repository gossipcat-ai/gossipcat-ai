import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

const DEFAULT_ALLOWED_COMMANDS = [
  'npm', 'npx', 'node', 'git', 'tsc', 'jest',
  'ls', 'cat', 'head', 'tail', 'wc', 'find', 'grep',
  'echo', 'pwd', 'which', 'env', 'sleep'
];

const BLOCKED_PATTERNS = [
  /rm\s+(-rf|-fr|--force)/,
  /git\s+push\s+--force/,
  /git\s+reset\s+--hard/,
  /dd\s+if=/,
  /mkfs/,
  /:\(\)\s*\{.*\|.*&.*\}/, // fork bomb
];

export interface ShellToolsOptions {
  allowedCommands?: string[];
  maxOutputSize?: number;
}

export class ShellTools {
  private allowedCommands: string[];
  private maxOutputSize: number;

  constructor(options?: ShellToolsOptions) {
    this.allowedCommands = options?.allowedCommands || DEFAULT_ALLOWED_COMMANDS;
    this.maxOutputSize = options?.maxOutputSize || 1024 * 1024; // 1MB
  }

  async shellExec(args: { command: string; timeout?: number; cwd?: string }): Promise<string> {
    const parts = args.command.trim().split(/\s+/);
    const cmd = parts[0];
    const cmdArgs = parts.slice(1);

    // Check allowlist
    if (!this.allowedCommands.includes(cmd)) {
      throw new Error(`Command "${cmd}" is not in the allowed commands list`);
    }

    // Check for blocked patterns
    for (const pattern of BLOCKED_PATTERNS) {
      if (pattern.test(args.command)) {
        throw new Error(`Command blocked by safety rules: ${args.command}`);
      }
    }

    try {
      // Use execFile (not exec) — prevents shell injection
      const { stdout, stderr } = await execFileAsync(cmd, cmdArgs, {
        cwd: args.cwd,
        timeout: args.timeout || 30000,
        maxBuffer: this.maxOutputSize,
        env: { ...process.env, FORCE_COLOR: '0' }
      });
      const output = stdout + (stderr ? `\nSTDERR:\n${stderr}` : '');
      return output.slice(0, this.maxOutputSize);
    } catch (err: unknown) {
      const error = err as NodeJS.ErrnoException & { killed?: boolean; stdout?: string; stderr?: string };
      if (error.killed) return `Command timed out after ${args.timeout || 30000}ms`;
      // execFile throws on non-zero exit codes, but stdout may still have content
      if (error.stdout || error.stderr) {
        const out = (error.stdout || '') + (error.stderr ? `\nSTDERR:\n${error.stderr}` : '');
        return out.slice(0, this.maxOutputSize);
      }
      throw new Error(`Command failed: ${error.message}`);
    }
  }
}
