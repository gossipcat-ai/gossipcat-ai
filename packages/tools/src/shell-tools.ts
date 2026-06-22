import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

const DEFAULT_ALLOWED_COMMANDS = [
  'npm', 'npx', 'node', 'git', 'tsc', 'jest',
  'ls', 'wc', 'echo', 'pwd', 'which',
  // REMOVED: env (leaks API keys), sleep (DoS vector),
  // cat/head/tail/grep (bypass sandbox — use file_read/file_grep instead)
];

const BLOCKED_PATTERNS = [
  /rm\s+(-rf|-fr|--force)/,
  /git\s+push\s+--force/,
  /git\s+reset\s+--hard/,
  /dd\s+if=/,
  /mkfs/,
  /:\(\)\s*\{.*\|.*&.*\}/, // fork bomb
];

const BLOCKED_ARG_PATTERNS = [
  /^-exec$/,
  /^-delete$/,
  /^--force$/,
  /^-rf$/,
  /^-fr$/,
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

  async shellExec(args: { command: string; args?: string[]; timeout?: number; cwd?: string }): Promise<string> {
    let cmd: string;
    let cmdArgs: string[];

    if (args.args) {
      // When args[] is provided, use directly (no string splitting)
      const parts = args.command.trim().split(/\s+/);
      cmd = parts[0];
      cmdArgs = args.args;
    } else {
      // Backwards compat: split command string
      const parts = args.command.trim().split(/\s+/);
      cmd = parts[0];
      cmdArgs = parts.slice(1);
    }

    // Check allowlist
    if (!this.allowedCommands.includes(cmd)) {
      const alternatives: Record<string, string> = {
        cat: 'Use file_read instead', head: 'Use file_read with startLine/endLine',
        tail: 'Use file_read with startLine/endLine', grep: 'Use file_grep instead',
        find: 'Use file_search instead', curl: 'Not available — describe what you need in your output',
        wget: 'Not available', rm: 'Use file_delete instead', mkdir: 'file_write auto-creates directories',
      };
      const hint = alternatives[cmd] ? `. ${alternatives[cmd]}` : `. Allowed: ${this.allowedCommands.join(', ')}`;
      throw new Error(`Command "${cmd}" is not allowed${hint}`);
    }

    // Check for blocked patterns against full command (including args)
    const fullCommand = [cmd, ...cmdArgs].join(' ');
    for (const pattern of BLOCKED_PATTERNS) {
      if (pattern.test(fullCommand)) {
        throw new Error(`Command blocked by safety rules: ${fullCommand}`);
      }
    }

    // Check each argument against blocked arg patterns
    for (const arg of cmdArgs) {
      for (const pattern of BLOCKED_ARG_PATTERNS) {
        if (pattern.test(arg)) {
          throw new Error(`Argument "${arg}" is blocked by safety rules`);
        }
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
