import { Option, type Command } from 'commander';
import { staticVerdict, type AutoVerdict } from './autoMode.js';
import { matchRules, projectRules } from './permissionRules.js';

/**
 * Permission modes (same names as Claude Code's --permission-mode):
 * - default: ask before write_file, edit_file, run_bash and MCP tools;
 * - acceptEdits: file edits are allowed, shell commands and MCP tools still ask;
 * - plan: read-only — look around and propose a plan; file changes and
 *   non-read-only commands are refused, MCP tools still ask;
 * - auto: file edits and read-only commands run, other shell commands and MCP
 *   tools are reviewed by the model first and only asked about when risky;
 * - bypassPermissions: never ask (only for sandboxes / throwaway machines).
 */
export const PERMISSION_MODES = ['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions'] as const;

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

export type PermissionDecision = { allow: true } | { allow: false; ask: string } | { allow: false; deny: string };

/**
 * What the permission mode and the project's /permissions rules say about
 * one action: `allow` runs it without asking, `deny` refuses it (the reason
 * goes back to the model), otherwise the user is asked with `ask` (the
 * description, plus auto mode's reason when the reviewer wanted a human look).
 */
export async function decidePermission(
  mode: PermissionMode,
  description: string,
  tool: string,
  review?: ReviewFn,
  workspaceRoot?: string,
): Promise<PermissionDecision> {
  const rule = workspaceRoot ? matchRules(projectRules(workspaceRoot), description, tool) : null;
  if (rule?.effect === 'deny') {
    return { allow: false, deny: `Denied by the /permissions rule "${rule.rule}".` };
  }
  if (mode === 'plan') {
    if (tool === 'run_bash' && staticVerdict(description, tool)?.allow) {
      return { allow: true };
    }
    if (EDIT_TOOLS.has(tool) || tool === 'run_bash') {
      return {
        allow: false,
        deny:
          'Plan mode is on: only read-only actions run. Finish investigating, then present your plan ' +
          'and wait for the user to approve it (they leave plan mode with Shift+Tab or /plan off).',
      };
    }
  }
  if (rule?.effect === 'allow') {
    return { allow: true };
  }
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
