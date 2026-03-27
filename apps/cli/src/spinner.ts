import { Interface as ReadlineInterface } from 'readline';

const c = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  cyan: '\x1b[36m',
  yellow: '\x1b[33m',
};

/**
 * Inline spinner with elapsed time display.
 * Coordinates with readline via pause/resume.
 * Shows: ⠋ thinking... 3.2s
 */
export class Spinner {
  private interval: NodeJS.Timeout | null = null;
  private frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  private idx = 0;
  private rl: ReadlineInterface | null = null;
  private paused = false;
  private startTime = 0;

  setReadline(rl: ReadlineInterface): void {
    this.rl = rl;
  }

  start(message: string): void {
    this.stop();
    this.idx = 0;
    this.startTime = Date.now();
    this.rl?.pause();
    this.paused = true;

    if (process.stdout.isTTY) {
      this.interval = setInterval(() => {
        const elapsed = ((Date.now() - this.startTime) / 1000).toFixed(1);
        const frame = this.frames[this.idx++ % this.frames.length];
        process.stdout.write(
          `\r  ${c.cyan}${frame}${c.reset} ${message} ${c.dim}${elapsed}s${c.reset}\x1b[K`
        );
      }, 80);
    } else {
      console.log(`  ... ${message}`);
    }
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
      if (process.stdout.isTTY) {
        process.stdout.write('\r\x1b[K');
      }
    }
    if (this.paused) {
      this.rl?.resume();
      this.paused = false;
    }
  }

  /** Get elapsed time in seconds since start() was called */
  elapsed(): number {
    return (Date.now() - this.startTime) / 1000;
  }
}
