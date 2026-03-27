import { Interface as ReadlineInterface } from 'readline';

const HIDE_CURSOR = '\x1b[?25l';
const SHOW_CURSOR = '\x1b[?25h';
const CLEAR_TO_END = '\x1b[J';

interface SelectorOption {
  value: string;
  label: string;
  hint?: string;
}

interface SelectorConfig {
  message: string;
  options: SelectorOption[];
  allowCustom?: boolean;
  rl: ReadlineInterface;
}

/** Strip ANSI escape codes to get visible character count */
function stripAnsi(str: string): string {
  return str.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
}

/** Truncate a string to fit within maxCols visible characters */
function truncate(str: string, maxCols: number): string {
  const visible = stripAnsi(str);
  if (visible.length <= maxCols) return str;
  // Find the position in the original string that corresponds to maxCols-1 visible chars
  let visCount = 0;
  let i = 0;
  while (i < str.length && visCount < maxCols - 1) {
    if (str[i] === '\x1b') {
      // Skip ANSI sequence
      const end = str.indexOf('m', i);
      if (end !== -1) { i = end + 1; continue; }
    }
    visCount++;
    i++;
  }
  return str.slice(0, i) + '\x1b[0m…';
}

export function inlineSelect(config: SelectorConfig): Promise<string | null> {
  const { message, options, allowCustom, rl } = config;

  const displayOptions = [...options];
  if (allowCustom) {
    displayOptions.push({ value: '__custom__', label: 'Type a custom response...', hint: 'e' });
  }

  return new Promise<string | null>((resolve) => {
    let cursor = 0;
    let done = false;
    const optionCount = displayOptions.length;
    // Lines: 1 blank + N options = N+1 lines (no wrapping since we truncate)
    const totalLines = optionCount + 1;

    rl.pause();

    const stdin = process.stdin;
    const wasRaw = stdin.isRaw;
    stdin.setRawMode(true);
    stdin.resume();

    const cols = process.stdout.columns || 80;

    function render(initial = false): void {
      if (!initial) {
        process.stdout.write(`\x1b[${totalLines}A`);
      }
      process.stdout.write(CLEAR_TO_END);

      // Blank line
      process.stdout.write('\n');

      // Options — truncated to terminal width, guaranteed 1 line each
      for (let i = 0; i < displayOptions.length; i++) {
        const opt = displayOptions[i];
        const isSelected = i === cursor;
        const hint = opt.hint ? ` \x1b[2m(${opt.hint})\x1b[0m` : '';

        let line: string;
        if (isSelected) {
          line = `  \x1b[36m❯\x1b[0m \x1b[1m${opt.label}\x1b[0m${hint}`;
        } else {
          line = `    \x1b[2m${opt.label}\x1b[0m${hint}`;
        }

        process.stdout.write(truncate(line, cols - 1) + '\n');
      }
    }

    function cleanup(): void {
      if (done) return;
      done = true;
      stdin.removeListener('data', onKey);
      stdin.setRawMode(wasRaw ?? false);
      process.stdout.write(SHOW_CURSOR);
      rl.resume();
    }

    function finish(value: string | null): void {
      cleanup();

      // Clear the options area
      process.stdout.write(`\x1b[${totalLines}A`);
      process.stdout.write(CLEAR_TO_END);

      // Show compact result
      if (value && value !== '__custom__') {
        const selected = displayOptions.find(o => o.value === value);
        process.stdout.write(` \x1b[36m${selected?.label || value}\x1b[0m\n\n`);
      } else if (value === '__custom__') {
        process.stdout.write(` \x1b[2m(custom response)\x1b[0m\n\n`);
      } else {
        process.stdout.write(` \x1b[2m(cancelled)\x1b[0m\n\n`);
      }

      resolve(value);
    }

    function onKey(data: Buffer): void {
      if (done) return;
      const key = data.toString();

      if (key === '\x03') { finish(null); return; }
      if (key === '\r' || key === '\n') { finish(displayOptions[cursor].value); return; }

      if (key === '\x1b[A' || key === 'k') {
        cursor = (cursor - 1 + displayOptions.length) % displayOptions.length;
        render();
        return;
      }
      if (key === '\x1b[B' || key === 'j') {
        cursor = (cursor + 1) % displayOptions.length;
        render();
        return;
      }

      const num = parseInt(key, 10);
      if (num >= 1 && num <= options.length) { finish(options[num - 1].value); return; }
      if (allowCustom && key === 'e') { finish('__custom__'); return; }
    }

    // Print message header (stays fixed)
    process.stdout.write(`\n\x1b[1m${message}\x1b[0m`);

    process.stdout.write(HIDE_CURSOR);
    render(true);
    stdin.on('data', onKey);
  });
}
