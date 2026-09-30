import { spawn } from 'node:child_process';

/** Longest a status line command may take before the old line is kept. */
const STATUS_LINE_TIMEOUT_MS = 2_000;

export interface StatusLineInput {
  session_id: string;
  model: { id: string; display_name: string };
  provider: string;
  workspace: { current_dir: string; project_dir: string };
  version: string;
  permission_mode: string;
  context_tokens: number;
}

/**
 * Runs the /statusline command (Claude Code's statusLine setting) with the
 * session as JSON on stdin and returns the first line it prints, or null.
 */
export function runStatusLine(command: string, input: StatusLineInput): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn(command, { cwd: input.workspace.current_dir, shell: true, stdio: ['pipe', 'pipe', 'ignore'] });
    let output = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve(null);
    }, STATUS_LINE_TIMEOUT_MS);
    child.stdout.on('data', (chunk: Buffer) => {
      output = (output + chunk.toString('utf8')).slice(0, 2_000);
    });
    child.on('error', () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.on('close', () => {
      clearTimeout(timer);
      // eslint-disable-next-line no-control-regex
      const line = output
        .split('\n')[0]
        ?.replace(/\x1b\[[0-9;]*m/g, '')
        .trim();
      resolve(line || null);
    });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(input));
  });
}
