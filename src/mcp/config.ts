import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * MCP server definitions in Claude Code's format, so an existing `.mcp.json`
 * works unchanged: `{ "mcpServers": { "<name>": { … } } }`.
 */
export interface StdioServerConfig {
  type?: 'stdio';
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface RemoteServerConfig {
  type: 'http' | 'sse';
  url: string;
  headers?: Record<string, string>;
}

export type McpServerConfig = StdioServerConfig | RemoteServerConfig;

export function isRemoteServer(config: McpServerConfig): config is RemoteServerConfig {
  return config.type === 'http' || config.type === 'sse';
}

/**
 * Where a server is defined:
 * - project: `.mcp.json` in the workspace (shared through the repo; asked before use);
 * - local: only you, only this folder (`~/.aiolah/mcp.json` → projects);
 * - user: you, in every folder (`~/.aiolah/mcp.json` → mcpServers).
 */
export const MCP_SCOPES = ['local', 'project', 'user'] as const;

export type McpScope = (typeof MCP_SCOPES)[number];

export interface McpServerEntry {
  name: string;
  scope: McpScope;
  config: McpServerConfig;
}

/** Choices made in the "New MCP server found in this project" dialog. */
export interface ProjectMcpChoices {
  enabled: string[];
  disabled: string[];
  /** "Use this and all future MCP servers in this project". */
  enableAll: boolean;
}

interface McpFile {
  mcpServers?: Record<string, McpServerConfig>;
}

interface UserMcpFile extends McpFile {
  projects?: Record<string, { mcpServers?: Record<string, McpServerConfig> }>;
}

interface ApprovalsFile {
  projects?: Record<string, Partial<ProjectMcpChoices>>;
}

const CONFIG_DIR = join(homedir(), '.aiolah');
export const USER_MCP_FILE = join(CONFIG_DIR, 'mcp.json');
const APPROVALS_FILE = join(CONFIG_DIR, 'mcp-approvals.json');

export function projectMcpFile(workspaceRoot: string): string {
  return join(resolve(workspaceRoot), '.mcp.json');
}

function readJson<T>(path: string): T | null {
  if (!existsSync(path)) {
    return null;
  }
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch (error) {
    throw new Error(`Could not read ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Writes JSON; files under ~/.aiolah can hold tokens (env, headers), so they are 0600. */
function writeJson(path: string, data: unknown, privateFile: boolean): void {
  if (privateFile) {
    mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  }
  const contents = `${JSON.stringify(data, null, 2)}\n`;
  writeFileSync(path, contents, { encoding: 'utf8', ...(privateFile ? { mode: 0o600 } : {}) });
  if (privateFile) {
    chmodSync(path, 0o600);
  }
}

function serversIn(servers: Record<string, McpServerConfig> | undefined, scope: McpScope): McpServerEntry[] {
  return Object.entries(servers ?? {})
    .filter(([, config]) => config && typeof config === 'object')
    .map(([name, config]) => ({ name, scope, config }));
}

/**
 * Every server visible from `workspaceRoot`. A name defined in more than one
 * scope resolves as in Claude Code: local wins over project, project over user.
 */
export function readMcpServers(workspaceRoot: string): McpServerEntry[] {
  const root = resolve(workspaceRoot);
  const user = readJson<UserMcpFile>(USER_MCP_FILE);
  const project = readJson<McpFile>(projectMcpFile(root));
  const byName = new Map<string, McpServerEntry>();
  for (const entry of [
    ...serversIn(user?.mcpServers, 'user'),
    ...serversIn(project?.mcpServers, 'project'),
    ...serversIn(user?.projects?.[root]?.mcpServers, 'local'),
  ]) {
    byName.set(entry.name, entry);
  }
  return [...byName.values()];
}

export function addMcpServer(workspaceRoot: string, scope: McpScope, name: string, config: McpServerConfig): string {
  const root = resolve(workspaceRoot);
  if (scope === 'project') {
    const path = projectMcpFile(root);
    const file = readJson<McpFile>(path) ?? {};
    file.mcpServers = { ...file.mcpServers, [name]: config };
    writeJson(path, file, false);
    return path;
  }
  const file = readJson<UserMcpFile>(USER_MCP_FILE) ?? {};
  if (scope === 'user') {
    file.mcpServers = { ...file.mcpServers, [name]: config };
  } else {
    const projects = file.projects ?? {};
    projects[root] = { ...projects[root], mcpServers: { ...projects[root]?.mcpServers, [name]: config } };
    file.projects = projects;
  }
  writeJson(USER_MCP_FILE, file, true);
  return USER_MCP_FILE;
}

/** Removes `name` from one scope (or every scope that has it); returns the scopes it was removed from. */
export function removeMcpServer(workspaceRoot: string, name: string, scope?: McpScope): McpScope[] {
  const root = resolve(workspaceRoot);
  const removed: McpScope[] = [];

  if (!scope || scope === 'project') {
    const path = projectMcpFile(root);
    const file = readJson<McpFile>(path);
    if (file?.mcpServers && name in file.mcpServers) {
      delete file.mcpServers[name];
      writeJson(path, file, false);
      removed.push('project');
    }
  }

  if (!scope || scope !== 'project') {
    const file = readJson<UserMcpFile>(USER_MCP_FILE);
    let changed = false;
    const local = file?.projects?.[root]?.mcpServers;
    if ((!scope || scope === 'local') && local && name in local) {
      delete local[name];
      removed.push('local');
      changed = true;
    }
    if ((!scope || scope === 'user') && file?.mcpServers && name in file.mcpServers) {
      delete file.mcpServers[name];
      removed.push('user');
      changed = true;
    }
    if (file && changed) {
      writeJson(USER_MCP_FILE, file, true);
    }
  }
  return removed;
}

export function projectChoices(workspaceRoot: string): ProjectMcpChoices {
  const saved = readJson<ApprovalsFile>(APPROVALS_FILE)?.projects?.[resolve(workspaceRoot)];
  return { enabled: saved?.enabled ?? [], disabled: saved?.disabled ?? [], enableAll: saved?.enableAll ?? false };
}

export function saveProjectChoices(workspaceRoot: string, choices: ProjectMcpChoices | null): void {
  const file = readJson<ApprovalsFile>(APPROVALS_FILE) ?? {};
  const projects = file.projects ?? {};
  if (choices) {
    projects[resolve(workspaceRoot)] = choices;
  } else {
    delete projects[resolve(workspaceRoot)];
  }
  writeJson(APPROVALS_FILE, { ...file, projects }, true);
}

/** Whether a project (.mcp.json) server may start: approved one by one, or all of them. */
export function projectServerStatus(choices: ProjectMcpChoices, name: string): 'approved' | 'rejected' | 'pending' {
  if (choices.disabled.includes(name)) {
    return 'rejected';
  }
  return choices.enableAll || choices.enabled.includes(name) ? 'approved' : 'pending';
}

/**
 * `${VAR}` and `${VAR:-default}` in command, args, env, url and headers are
 * filled from the environment (as in Claude Code), so a shared `.mcp.json`
 * can refer to each developer's own tokens. A missing variable without a
 * default is an error rather than an empty string.
 */
export function expandConfig(config: McpServerConfig): McpServerConfig {
  const missing = new Set<string>();
  const expand = (value: string) =>
    value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_, name: string, fallback: string | undefined) => {
      const current = process.env[name];
      if (current !== undefined) return current;
      if (fallback !== undefined) return fallback;
      missing.add(name);
      return '';
    });
  const expandRecord = (record: Record<string, string> | undefined) =>
    record ? Object.fromEntries(Object.entries(record).map(([key, value]) => [key, expand(String(value))])) : undefined;

  const expanded: McpServerConfig = isRemoteServer(config)
    ? { type: config.type, url: expand(config.url), headers: expandRecord(config.headers) }
    : {
        type: 'stdio',
        command: expand(config.command),
        args: config.args?.map((arg) => expand(String(arg))),
        env: expandRecord(config.env),
      };
  if (missing.size) {
    throw new Error(`missing environment variable${missing.size > 1 ? 's' : ''} ${[...missing].join(', ')}`);
  }
  return expanded;
}

/** One-line summary: the command line or the URL. */
export function describeConfig(config: McpServerConfig): string {
  if (isRemoteServer(config)) {
    return `${config.url} (${config.type.toUpperCase()})`;
  }
  return [config.command, ...(config.args ?? [])].join(' ');
}
