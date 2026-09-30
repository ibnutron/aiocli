import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/** `/loop` without an interval runs every 10 minutes. */
export const DEFAULT_LOOP_INTERVAL_MS = 10 * 60_000;
const MIN_LOOP_INTERVAL_MS = 10_000;

/** What `/loop` runs without a prompt, when there is no loop.md (Claude Code's maintenance prompt, in spirit). */
export const MAINTENANCE_PROMPT = [
  'Check on the work in this workspace: continue any task from this conversation that is not finished, and look',
  'for failing tests, builds or errors you can fix. Keep changes small and explain briefly what you did.',
  'If there is nothing to do, reply "Nothing to do." in one line.',
].join('\n');

/** `30s`, `5m`, `1h` → milliseconds; null when it isn't an interval. */
export function parseInterval(text: string | undefined): number | null {
  const match = /^(\d+)\s*(s|m|h)$/i.exec(text?.trim() ?? '');
  if (!match) {
    return null;
  }
  const unit = { s: 1_000, m: 60_000, h: 3_600_000 }[match[2]!.toLowerCase() as 's' | 'm' | 'h'];
  return Math.max(MIN_LOOP_INTERVAL_MS, Number(match[1]) * unit);
}

export function formatInterval(ms: number): string {
  return ms % 3_600_000 === 0 ? `${ms / 3_600_000}h` : ms % 60_000 === 0 ? `${ms / 60_000}m` : `${ms / 1000}s`;
}

/** The default loop prompt: loop.md in the project (.aiolah/, .claude/) or ~/.aiolah/, else the built-in one. */
export function defaultLoopPrompt(workspaceRoot: string): string {
  const root = resolve(workspaceRoot);
  for (const path of [
    join(root, '.aiolah', 'loop.md'),
    join(root, '.claude', 'loop.md'),
    join(homedir(), '.aiolah', 'loop.md'),
  ]) {
    try {
      const text = readFileSync(path, 'utf8').trim();
      if (text) {
        return text;
      }
    } catch {
      // not there
    }
  }
  return MAINTENANCE_PROMPT;
}

/**
 * Runs `tick` every `intervalMs` while the chat is open. A tick while the
 * agent is still busy is skipped (the next one comes at the next interval).
 */
export class LoopRunner {
  private timer: NodeJS.Timeout | null = null;
  current: { intervalMs: number; prompt: string; runs: number } | null = null;

  start(intervalMs: number, prompt: string, tick: (prompt: string, run: number) => void): void {
    this.stop();
    this.current = { intervalMs, prompt, runs: 0 };
    const fire = () => {
      if (!this.current) return;
      this.current.runs += 1;
      tick(prompt, this.current.runs);
    };
    this.timer = setInterval(fire, intervalMs);
    fire();
  }

  stop(): boolean {
    const wasRunning = this.timer !== null;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.current = null;
    return wasRunning;
  }
}
