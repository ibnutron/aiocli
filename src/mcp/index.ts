import { stderr } from 'node:process';
import { canAsk, selectDialog } from '../dialog.js';
import { style } from '../ui.js';
import {
  describeConfig,
  projectChoices,
  projectServerStatus,
  readMcpServers,
  saveProjectChoices,
  type McpServerEntry,
} from './config.js';
import { McpManager, type McpServerStatus } from './manager.js';

export { McpManager } from './manager.js';

/**
 * Loads the MCP servers for `workspaceRoot` and connects to the ones that may
 * run. Servers from the project's `.mcp.json` come from the repo, not from
 * you, so each new one is asked about first (in a terminal); without a
 * terminal (or with `ask: false`), unapproved project servers are skipped.
 * Your own servers (local and user scope) always start.
 */
export async function startMcp(workspaceRoot: string, { ask = canAsk() } = {}): Promise<McpManager> {
  const manager = new McpManager(workspaceRoot);
  let servers: McpServerEntry[];
  try {
    servers = readMcpServers(workspaceRoot);
  } catch (error) {
    stderr.write(`${style.yellow(`MCP: ${error instanceof Error ? error.message : String(error)}`)}\n`);
    return manager;
  }
  if (!servers.length) {
    return manager;
  }

  const choices = projectChoices(workspaceRoot);
  const pending = servers.filter(
    (entry) => entry.scope === 'project' && projectServerStatus(choices, entry.name) === 'pending',
  );
  if (pending.length && ask) {
    const before = JSON.stringify(choices);
    for (const entry of pending) {
      if (choices.enableAll) {
        break;
      }
      const answer = await askAboutServer(entry);
      if (answer === 0) {
        choices.enabled.push(entry.name);
      } else if (answer === 1) {
        choices.enableAll = true;
      } else if (answer === 2) {
        choices.disabled.push(entry.name);
      }
    }
    if (JSON.stringify(choices) !== before) {
      saveProjectChoices(workspaceRoot, choices);
    }
  }

  const runnable: McpServerEntry[] = [];
  const skipped: { entry: McpServerEntry; state: 'pending' | 'rejected' }[] = [];
  for (const entry of servers) {
    const state = entry.scope === 'project' ? projectServerStatus(choices, entry.name) : 'approved';
    if (state === 'approved') {
      runnable.push(entry);
    } else {
      skipped.push({ entry, state });
    }
  }
  await manager.start(runnable, skipped);
  return manager;
}

/** Claude Code's "New MCP server found in this project" question; null = decide later. */
function askAboutServer(entry: McpServerEntry): Promise<number | null> {
  return selectDialog({
    title: style.red(`New MCP server found in this project: ${entry.name}`),
    body: [
      '',
      'MCP servers may execute code or access system resources. All tool calls require approval.',
      style.gray(`Runs: ${describeConfig(entry.config)}`),
    ],
    choices: [
      'Use this MCP server',
      'Use this and all future MCP servers in this project',
      'Continue without using this MCP server',
    ],
    hint: 'Enter to confirm · Esc to decide next time',
  });
}

/** Notice when a server failed to start, or null. */
export function mcpSummary(manager: McpManager): string | null {
  const failed = manager.status.filter((server) => server.state === 'failed');
  const signIn = manager.status.filter((server) => server.state === 'needs_auth');
  const parts = [
    failed.length ? `${failed.map((server) => server.name).join(', ')} failed to start` : '',
    signIn.length ? `${signIn.map((server) => server.name).join(', ')} need sign-in (aiolah mcp auth <name>)` : '',
  ].filter(Boolean);
  return parts.length ? `MCP: ${parts.join('; ')} — see /mcp` : null;
}

const STATE_LABEL: Record<McpServerStatus['state'], (text: string) => string> = {
  connected: style.green,
  failed: style.red,
  pending: style.yellow,
  rejected: style.gray,
  needs_auth: style.yellow,
};

const STATE_TEXT: Record<McpServerStatus['state'], string> = {
  connected: '✔ connected',
  failed: '✘ failed',
  pending: '… not approved yet (asked on the next interactive start)',
  rejected: '– not used (you chose to continue without it)',
  needs_auth: '! needs sign-in',
};

/** Server list for `/mcp` and `aiolah mcp list`. */
export function formatMcpStatus(servers: McpServerStatus[]): string {
  if (!servers.length) {
    return style.gray('  No MCP servers. Add one with: aiolah mcp add <name> -- <command> [args…]');
  }
  return servers
    .map((server) => {
      const tools = server.state === 'connected' ? style.gray(` · ${server.tools.length} tools`) : '';
      const state = STATE_LABEL[server.state](STATE_TEXT[server.state]);
      const lines = [
        `  ${style.bold(server.name)} ${style.gray(`(${server.scope})`)}  ${state}${tools}`,
        `    ${style.gray(describeConfig(server.config))}`,
      ];
      if (server.error) {
        lines.push(`    ${style.red(server.error)}`);
      }
      return lines.join('\n');
    })
    .join('\n');
}
