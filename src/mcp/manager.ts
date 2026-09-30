import type Anthropic from '@anthropic-ai/sdk';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { packageVersion } from '../version.js';
import { log } from '../log.js';
import { expandConfig, isRemoteServer, type McpServerConfig, type McpServerEntry } from './config.js';

export type McpServerState = 'connected' | 'failed' | 'pending' | 'rejected';

/** A server as `/mcp` and `aiolah mcp list` show it. */
export interface McpServerStatus {
  name: string;
  scope: McpServerEntry['scope'];
  config: McpServerConfig;
  state: McpServerState;
  tools: string[];
  error?: string;
}

interface Connected {
  client: Client;
  /** Tool name as the model sees it → the server's own tool name. */
  tools: Map<string, string>;
}

const CONNECT_TIMEOUT_MS = Number(process.env.MCP_TIMEOUT) || 30_000;
const TOOL_TIMEOUT_MS = Number(process.env.MCP_TOOL_TIMEOUT) || 10 * 60_000;
/** Longer tool results are cut, so one call can't flood the context window. */
const MAX_RESULT_CHARS = 100_000;
const STDERR_TAIL_CHARS = 2_000;

export const MCP_TOOL_PREFIX = 'mcp__';

/** `mcp__<server>__<tool>`, limited to the characters and length tool names allow. */
export function mcpToolName(server: string, tool: string): string {
  const clean = (text: string) => text.replace(/[^a-zA-Z0-9_-]/g, '_');
  return `${MCP_TOOL_PREFIX}${clean(server)}__${clean(tool)}`.slice(0, 64);
}

/**
 * The MCP servers of one aiolah process: starts the approved ones, exposes
 * their tools to the model as `mcp__<server>__<tool>` and runs tool calls.
 * A server that fails to start is reported, never fatal.
 */
export class McpManager {
  private readonly connected = new Map<string, Connected>();
  private readonly statuses: McpServerStatus[] = [];
  private schemas: Anthropic.Tool[] = [];
  /** Model tool name → server name. */
  private readonly owners = new Map<string, string>();

  constructor(private readonly workspaceRoot: string) {}

  /**
   * Connects to `servers` in parallel. `skipped` are listed with their state
   * (not approved yet / rejected) so `/mcp` can explain why they are missing.
   */
  async start(servers: McpServerEntry[], skipped: { entry: McpServerEntry; state: 'pending' | 'rejected' }[] = []) {
    for (const { entry, state } of skipped) {
      this.statuses.push({ name: entry.name, scope: entry.scope, config: entry.config, state, tools: [] });
    }
    await Promise.all(servers.map((entry) => this.connect(entry)));
    this.statuses.sort((a, b) => a.name.localeCompare(b.name));
  }

  get status(): McpServerStatus[] {
    return this.statuses;
  }

  /** Tool definitions to send to the model with every request. */
  get toolSchemas(): Anthropic.Tool[] {
    return this.schemas;
  }

  owns(toolName: string): boolean {
    return this.owners.has(toolName);
  }

  /** "server/tool" for Allow/Deny prompts. */
  describe(toolName: string): string {
    const server = this.owners.get(toolName) ?? '?';
    return `${server}/${this.connected.get(server)?.tools.get(toolName) ?? toolName}`;
  }

  async call(toolName: string, input: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
    const server = this.owners.get(toolName);
    const connection = server ? this.connected.get(server) : undefined;
    const tool = connection?.tools.get(toolName);
    if (!connection || !tool) {
      throw new Error(`Unknown MCP tool: ${toolName}`);
    }
    const result = await connection.client.callTool({ name: tool, arguments: input }, undefined, {
      signal,
      timeout: TOOL_TIMEOUT_MS,
      resetTimeoutOnProgress: true,
    });
    return formatToolResult(result as ToolResultLike);
  }

  async close(): Promise<void> {
    await Promise.allSettled([...this.connected.values()].map(({ client }) => client.close()));
    this.connected.clear();
  }

  private async connect(entry: McpServerEntry): Promise<void> {
    const status: McpServerStatus = {
      name: entry.name,
      scope: entry.scope,
      config: entry.config,
      state: 'failed',
      tools: [],
    };
    this.statuses.push(status);

    let stderrTail = '';
    const client = new Client({ name: 'aiolah', version: packageVersion() });
    try {
      const transport = this.transportFor(expandConfig(entry.config));
      if (transport instanceof StdioClientTransport) {
        // Server logs would draw over the chat box; keep the end for error messages.
        transport.stderr?.on('data', (chunk: Buffer) => {
          stderrTail = (stderrTail + chunk.toString('utf8')).slice(-STDERR_TAIL_CHARS);
        });
      }
      await client.connect(transport, { timeout: CONNECT_TIMEOUT_MS });

      const tools = new Map<string, string>();
      if (client.getServerCapabilities()?.tools) {
        let cursor: string | undefined;
        do {
          const page = await client.listTools(cursor ? { cursor } : undefined, { timeout: CONNECT_TIMEOUT_MS });
          for (const tool of page.tools) {
            const name = mcpToolName(entry.name, tool.name);
            if (this.owners.has(name) || tools.has(name)) {
              continue;
            }
            tools.set(name, tool.name);
            this.schemas.push({
              name,
              description: `${tool.description ?? tool.title ?? tool.name} (MCP server "${entry.name}")`.slice(0, 1024),
              input_schema: tool.inputSchema as Anthropic.Tool.InputSchema,
            });
          }
          cursor = page.nextCursor;
        } while (cursor);
      }

      for (const name of tools.keys()) {
        this.owners.set(name, entry.name);
      }
      this.connected.set(entry.name, { client, tools });
      status.state = 'connected';
      log('INFO', 'mcp server connected', { server: entry.name, tools: tools.size });
      status.tools = [...tools.values()];
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const logLine = stderrTail.trim().split('\n').pop();
      status.error = logLine && !message.includes(logLine) ? `${message} — ${logLine}` : message;
      log('WARN', 'mcp server failed', { server: entry.name, error: status.error });
      await client.close().catch(() => undefined);
    }
  }

  private transportFor(config: McpServerConfig): Transport {
    if (isRemoteServer(config)) {
      const url = new URL(config.url);
      const requestInit = config.headers ? { headers: config.headers } : undefined;
      return config.type === 'http'
        ? new StreamableHTTPClientTransport(url, { requestInit })
        : new SSEClientTransport(url, { requestInit });
    }
    return new StdioClientTransport({
      command: config.command,
      args: config.args ?? [],
      env: { ...getDefaultEnvironment(), ...(process.env as Record<string, string>), ...config.env },
      cwd: this.workspaceRoot,
      stderr: 'pipe',
    });
  }
}

interface ToolResultLike {
  content?: {
    type: string;
    text?: string;
    mimeType?: string;
    resource?: { uri?: string; text?: string };
  }[];
  structuredContent?: unknown;
  isError?: boolean;
  toolResult?: unknown;
}

/** Text for the model: text parts as is, other parts summarised, errors marked. */
function formatToolResult(result: ToolResultLike): string {
  const parts: string[] = [];
  for (const part of result.content ?? []) {
    if (part.type === 'text') {
      parts.push(part.text ?? '');
    } else if (part.type === 'resource') {
      parts.push(part.resource?.text ?? `[resource ${part.resource?.uri ?? ''}]`);
    } else if (part.type === 'resource_link') {
      parts.push(`[resource link ${(part as { uri?: string }).uri ?? ''}]`);
    } else {
      parts.push(`[${part.type}${part.mimeType ? ` ${part.mimeType}` : ''} omitted]`);
    }
  }
  if (!parts.length && result.structuredContent !== undefined) {
    parts.push(JSON.stringify(result.structuredContent, null, 2));
  }
  if (!parts.length && result.toolResult !== undefined) {
    parts.push(JSON.stringify(result.toolResult, null, 2));
  }
  let text = parts.join('\n') || '(no output)';
  if (text.length > MAX_RESULT_CHARS) {
    text = `${text.slice(0, MAX_RESULT_CHARS)}\n… (output cut at ${MAX_RESULT_CHARS} characters)`;
  }
  return result.isError ? `Error: ${text}` : text;
}
