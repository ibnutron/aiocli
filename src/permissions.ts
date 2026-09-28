import { Option, type Command } from 'commander';
import type { ConfirmFn } from './tools/index.js';

/**
 * Permission modes (same names as Claude Code's --permission-mode):
 * - default: ask before write_file, edit_file and run_bash;
 * - acceptEdits: file edits are allowed, shell commands still ask;
 * - bypassPermissions: never ask (only for sandboxes / throwaway machines).
 */
export const PERMISSION_MODES = ['default', 'acceptEdits', 'bypassPermissions'] as const;

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

/**
 * Wraps an interactive ask so the permission mode can answer first. Pass a
 * function to read the mode on every call (it can change mid-session).
 */
export function applyPermissionMode(mode: PermissionMode | (() => PermissionMode), ask: ConfirmFn): ConfirmFn {
  const currentMode = typeof mode === 'function' ? mode : () => mode;
  return async (description, tool) => {
    const active = currentMode();
    if (active === 'bypassPermissions' || (active === 'acceptEdits' && EDIT_TOOLS.has(tool))) {
      return true;
    }
    return ask(description, tool);
  };
}
