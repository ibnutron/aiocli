import { Option, type Command } from 'commander';
import { staticVerdict, type AutoVerdict } from './autoMode.js';

/**
 * Permission modes (same names as Claude Code's --permission-mode):
 * - default: ask before write_file, edit_file, run_bash and MCP tools;
 * - acceptEdits: file edits are allowed, shell commands and MCP tools still ask;
 * - auto: file edits and read-only commands run, other shell commands and MCP
 *   tools are reviewed by the model first and only asked about when risky;
 * - bypassPermissions: never ask (only for sandboxes / throwaway machines).
 */
export const PERMISSION_MODES = ['default', 'acceptEdits', 'auto', 'bypassPermissions'] as const;

export type PermissionMode = (typeof PERMISSION_MODES)[number];

export interface PermissionOptions {
  permissionMode?: string;
  dangerouslySkipPermissions?: boolean;
  /** Deprecated alias of --dangerously-skip-permissions, kept for existing scripts. */
  yolo?: boolean;
}

const EDIT_TOOLS = new Set(['write_file', 'edit_file']);

export function addPermissionOptions(command: Command): Command {
  return command
    .addOption(
      new Option('--permission-mode <mode>', 'when to ask before changing files or running commands')
        .choices(PERMISSION_MODES)
        .default('default'),
    )
    .option('--dangerously-skip-permissions', 'never ask (same as --permission-mode bypassPermissions)')
    .addOption(new Option('--yolo').hideHelp());
}

export function resolvePermissionMode(options: PermissionOptions): PermissionMode {
  if (options.dangerouslySkipPermissions || options.yolo) {
    return 'bypassPermissions';
  }
  return (options.permissionMode as PermissionMode | undefined) ?? 'default';
}

/** The mode after `mode` when cycling with Shift+Tab in `aiolah chat`. */
export function nextPermissionMode(mode: PermissionMode): PermissionMode {
  return PERMISSION_MODES[(PERMISSION_MODES.indexOf(mode) + 1) % PERMISSION_MODES.length]!;
}

/** Asks the model whether an action may run (auto mode). */
export type ReviewFn = (description: string, tool: string) => Promise<AutoVerdict>;

/**
 * What the permission mode says about one action: `allow` runs it without
 * asking; otherwise the user is asked with `ask` (the description, plus auto
 * mode's reason when the reviewer wanted a human look).
 */
export async function decidePermission(
  mode: PermissionMode,
  description: string,
  tool: string,
  review?: ReviewFn,
): Promise<{ allow: true } | { allow: false; ask: string }> {
  if (mode === 'bypassPermissions' || (mode === 'acceptEdits' && EDIT_TOOLS.has(tool))) {
    return { allow: true };
  }
  if (mode === 'auto') {
    const verdict = staticVerdict(description, tool) ?? (review ? await review(description, tool) : null);
    if (verdict?.allow) {
      return { allow: true };
    }
    return { allow: false, ask: verdict ? `${description} — auto mode: ${verdict.reason}` : description };
  }
  return { allow: false, ask: description };
}
