import { stdin, stdout } from 'node:process';
import { isAbsolute, resolve } from 'node:path';
import { ChatSession, TurnInterruptedError } from '../session.js';
import { SessionSync } from '../sessionSync.js';
import { resolveSelection } from '../providers.js';
import { McpManager } from '../mcp/manager.js';
import { readMcpServers, projectChoices, projectServerStatus, type McpServerEntry } from '../mcp/config.js';
import {
  PERMISSION_MODES,
  resolvePermissionMode,
  type PermissionMode,
  type PermissionOptions,
} from '../permissions.js';
import { packageVersion } from '../version.js';
import { toolActivity } from '../ui.js';
import { log } from '../log.js';
import type { ImageInput } from '../protocol.js';

/**
 * `aiolah acp`: the agent side of the Agent Client Protocol (agentclientprotocol.com),
 * so editors such as Zed can run aiolah as their agent. JSON-RPC 2.0, one
 * message per line on stdin/stdout (stdout carries nothing else).
 */
const PROTOCOL_VERSION = 1;

interface AcpOptions extends PermissionOptions {
  model?: string;
  provider?: string;
}

type Json = Record<string, unknown>;

interface AcpMcpServer {
  name?: string;
  command?: string;
  args?: string[];
  env?: { name: string; value: string }[];
  type?: string;
  url?: string;
  headers?: { name: string; value: string }[];
}

interface AcpSession {
  session: ChatSession;
  mcp: McpManager;
  mode: PermissionMode;
  /** Tool calls in progress (a stack: subagent calls run inside their task call). */
  toolCalls: { id: string; name: string; input: Json }[];
  alwaysAllowed: Set<string>;
  /** Whether the running prompt's answer was already sent in pieces. */
  streamed: boolean;
}

const MODE_NAMES: Record<PermissionMode, string> = {
  default: 'Default (ask before changes)',
  acceptEdits: 'Accept edits',
  plan: 'Plan (read-only)',
  auto: 'Auto (review risky actions)',
  bypassPermissions: 'Bypass permissions',
};

/** ACP tool kinds for aiolah's tools. */
function toolKind(name: string): string {
  if (name === 'read_file' || name === 'use_skill') return 'read';
  if (name === 'list_dir') return 'search';
  if (name === 'write_file' || name === 'edit_file') return 'edit';
  if (name === 'run_bash') return 'execute';
  if (name === 'task') return 'think';
  return 'other';
}

export async function acpCommand(options: AcpOptions): Promise<void> {
  const sessions = new Map<string, AcpSession>();
  const pending = new Map<number, (value: { result?: Json; error?: Json }) => void>();
  let nextId = 1;
  let callCounter = 0;
  const defaultMode = resolvePermissionMode(options);

  const send = (message: Json) => stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
  const notify = (sessionId: string, update: Json) => send({ method: 'session/update', params: { sessionId, update } });
  const request = (method: string, params: Json) =>
    new Promise<{ result?: Json; error?: Json }>((resolveRequest) => {
      const id = nextId++;
      pending.set(id, resolveRequest);
      send({ id, method, params });
    });

  function modeState(mode: PermissionMode): Json {
    return {
      currentModeId: mode,
      availableModes: PERMISSION_MODES.map((id) => ({ id, name: MODE_NAMES[id] })),
    };
  }

  /** The workspace's own MCP servers (yours and approved project ones) plus the editor's. */
  async function startMcp(cwd: string, fromClient: AcpMcpServer[]): Promise<McpManager> {
    const manager = new McpManager(cwd);
    const choices = projectChoices(cwd);
    const own = readMcpServers(cwd).filter(
      (entry) => entry.scope !== 'project' || projectServerStatus(choices, entry.name) === 'approved',
    );
    const client: McpServerEntry[] = fromClient
      .filter((server) => server.name && (server.command || server.url))
      .map((server) => ({
        name: String(server.name),
        scope: 'local' as const,
        config: server.url
          ? {
              type: server.type === 'sse' ? ('sse' as const) : ('http' as const),
              url: server.url,
              headers: Object.fromEntries((server.headers ?? []).map((header) => [header.name, header.value])),
            }
          : {
              command: String(server.command),
              args: server.args ?? [],
              env: Object.fromEntries((server.env ?? []).map((variable) => [variable.name, variable.value])),
            },
      }));
    const names = new Set(client.map((entry) => entry.name));
    await manager.start([...client, ...own.filter((entry) => !names.has(entry.name))]);
    return manager;
  }

  async function openSession(params: Json, resumeId?: string): Promise<AcpSession> {
    const cwd = String(params.cwd ?? '');
    if (!cwd || !isAbsolute(cwd)) {
      throw Object.assign(new Error('cwd must be an absolute path'), { code: -32602 });
    }
    const mcp = await startMcp(cwd, (params.mcpServers as AcpMcpServer[]) ?? []);
    const state: Partial<AcpSession> = {
      mode: defaultMode,
      toolCalls: [],
      alwaysAllowed: new Set(),
      mcp,
      streamed: false,
    };
    const session = new ChatSession({
      ...(await resolveSelection(options)),
      workspaceRoot: resolve(cwd),
      permissionMode: () => state.mode ?? 'default',
      resumeId,
      mcp,
      confirm: async (description, tool) => {
        if (state.alwaysAllowed!.has(tool)) {
          return true;
        }
        const call = state.toolCalls![state.toolCalls!.length - 1];
        const response = await request('session/request_permission', {
          sessionId: session.sessionId,
          toolCall: {
            toolCallId: call?.id ?? `call_${++callCounter}`,
            title: description,
            kind: toolKind(tool),
            status: 'pending',
            rawInput: call?.input ?? {},
          },
          options: [
            { optionId: 'allow_once', name: 'Allow', kind: 'allow_once' },
            { optionId: 'allow_always', name: 'Always allow in this session', kind: 'allow_always' },
            { optionId: 'reject_once', name: 'Reject', kind: 'reject_once' },
          ],
        });
        const outcome = (response.result?.outcome ?? {}) as { outcome?: string; optionId?: string };
        if (outcome.outcome === 'selected' && outcome.optionId === 'allow_always') {
          state.alwaysAllowed!.add(tool);
        }
        return outcome.outcome === 'selected' && outcome.optionId?.startsWith('allow') === true;
      },
    });
    for (const dir of (params.additionalDirectories as string[]) ?? []) {
      try {
        session.addDir(dir);
      } catch {
        // missing directory: ignore
      }
    }
    const acpSession = Object.assign(state, { session }) as AcpSession;

    session.on('text', ({ text }: { text: string }) => {
      acpSession.streamed = true;
      notify(session.sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });
    });
    session.on('tool', ({ name, input }: { name: string; input: Json }) => {
      const id = `call_${++callCounter}`;
      acpSession.toolCalls.push({ id, name, input });
      const path = typeof input?.path === 'string' ? resolve(session.workspace, input.path) : undefined;
      notify(session.sessionId, {
        sessionUpdate: 'tool_call',
        toolCallId: id,
        title: toolActivity(name, input),
        kind: toolKind(name),
        status: 'in_progress',
        rawInput: input,
        ...(path ? { locations: [{ path }] } : {}),
      });
    });
    session.on('tool_result', ({ result }: { name: string; result: string }) => {
      const call = acpSession.toolCalls.pop();
      if (!call) return;
      const failed = /^(Error:|User declined|Blocked by)/.test(result);
      const path = typeof call.input.path === 'string' ? resolve(session.workspace, call.input.path) : '';
      const content =
        !failed && call.name === 'edit_file'
          ? [
              {
                type: 'diff',
                path,
                oldText: String(call.input.old_string ?? ''),
                newText: String(call.input.new_string ?? ''),
              },
            ]
          : !failed && call.name === 'write_file'
            ? [{ type: 'diff', path, oldText: null, newText: String(call.input.content ?? '') }]
            : [{ type: 'content', content: { type: 'text', text: result.slice(0, 20_000) } }];
      notify(session.sessionId, {
        sessionUpdate: 'tool_call_update',
        toolCallId: call.id,
        status: failed ? 'failed' : 'completed',
        content,
      });
    });

    await session.startSession(resumeId ? 'resume' : 'startup');
    SessionSync.attach(session, { origin: 'terminal' });
    sessions.set(session.sessionId, acpSession);
    return acpSession;
  }

  /** Replays a loaded session to the client as session/update notifications. */
  function replay(acpSession: AcpSession): void {
    const id = acpSession.session.sessionId;
    for (const item of acpSession.session.renderHistory()) {
      if (item.role === 'tool') {
        const toolCallId = `call_${++callCounter}`;
        notify(id, {
          sessionUpdate: 'tool_call',
          toolCallId,
          title: toolActivity(item.name, item.input),
          kind: toolKind(item.name),
          status: 'completed',
          rawInput: item.input ?? {},
          content: [{ type: 'content', content: { type: 'text', text: item.result.slice(0, 20_000) } }],
        });
      } else {
        notify(id, {
          sessionUpdate: item.role === 'user' ? 'user_message_chunk' : 'agent_message_chunk',
          content: { type: 'text', text: item.text },
        });
      }
    }
  }

  /** ACP prompt blocks → the text and images aiolah sends to the model. */
  function toPrompt(blocks: Json[]): { text: string; images: ImageInput[] } {
    const parts: string[] = [];
    const images: ImageInput[] = [];
    for (const block of blocks) {
      if (block.type === 'text') {
        parts.push(String(block.text ?? ''));
      } else if (block.type === 'resource') {
        const resource = (block.resource ?? {}) as Json;
        if (typeof resource.text === 'string') {
          parts.push(`<file uri="${String(resource.uri ?? '')}">\n${resource.text}\n</file>`);
        }
      } else if (block.type === 'resource_link') {
        parts.push(`@${String(block.uri ?? block.name ?? '')}`);
      } else if (block.type === 'image' && typeof block.data === 'string') {
        images.push({
          media_type: String(block.mimeType ?? 'image/png') as ImageInput['media_type'],
          data: block.data,
        });
      }
    }
    return { text: parts.join('\n\n').trim(), images };
  }

  async function handle(message: Json): Promise<Json | undefined> {
    const params = (message.params ?? {}) as Json;
    switch (message.method) {
      case 'initialize':
        return {
          protocolVersion: PROTOCOL_VERSION,
          agentCapabilities: {
            loadSession: true,
            promptCapabilities: { image: true, audio: false, embeddedContext: true },
            mcpCapabilities: { http: true, sse: true },
          },
          authMethods: [],
          agentInfo: { name: 'aiolah', title: 'aiolah', version: packageVersion() },
        };
      case 'authenticate':
        return {};
      case 'session/new': {
        const acpSession = await openSession(params);
        return { sessionId: acpSession.session.sessionId, modes: modeState(acpSession.mode) };
      }
      case 'session/load': {
        const acpSession = await openSession(params, String(params.sessionId ?? ''));
        replay(acpSession);
        return { modes: modeState(acpSession.mode) };
      }
      case 'session/set_mode': {
        const acpSession = sessions.get(String(params.sessionId));
        if (!acpSession || !(PERMISSION_MODES as readonly string[]).includes(String(params.modeId))) {
          throw Object.assign(new Error('unknown session or mode'), { code: -32602 });
        }
        acpSession.mode = params.modeId as PermissionMode;
        return {};
      }
      case 'session/prompt': {
        const acpSession = sessions.get(String(params.sessionId));
        if (!acpSession) {
          throw Object.assign(new Error('unknown session'), { code: -32602 });
        }
        const { text, images } = toPrompt((params.prompt as Json[]) ?? []);
        acpSession.streamed = false;
        try {
          const { reply } = await acpSession.session.send(text || '(empty prompt)', 'terminal', images);
          if (!acpSession.streamed && reply.trim()) {
            notify(acpSession.session.sessionId, {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: reply },
            });
          }
          return { stopReason: 'end_turn' };
        } catch (error) {
          if (error instanceof TurnInterruptedError) {
            return { stopReason: 'cancelled' };
          }
          throw error;
        }
      }
      case 'session/cancel':
        sessions.get(String(params.sessionId))?.session.interrupt();
        return undefined;
      default:
        throw Object.assign(new Error(`Method not found: ${String(message.method)}`), { code: -32601 });
    }
  }

  let buffer = '';
  stdin.setEncoding('utf8');
  stdin.on('data', (chunk: string) => {
    buffer += chunk;
    let newline = buffer.indexOf('\n');
    while (newline !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf('\n');
      if (!line) continue;
      let message: Json;
      try {
        message = JSON.parse(line) as Json;
      } catch {
        send({ id: null, error: { code: -32700, message: 'Parse error' } });
        continue;
      }
      // A response to one of our requests (session/request_permission).
      if (message.id !== undefined && message.method === undefined) {
        pending.get(Number(message.id))?.({ result: message.result as Json, error: message.error as Json });
        pending.delete(Number(message.id));
        continue;
      }
      log('DEBUG', 'acp message', { method: message.method });
      void handle(message).then(
        (result) => {
          if (message.id !== undefined) send({ id: message.id, result: result ?? null });
        },
        (error: unknown) => {
          const code = (error as { code?: number }).code ?? -32603;
          const text = error instanceof Error ? error.message : String(error);
          log('WARN', 'acp error', { method: message.method, error: text });
          if (message.id !== undefined) send({ id: message.id, error: { code, message: text } });
        },
      );
    }
  });
  await new Promise<void>((resolveEnd) => stdin.on('end', resolveEnd));
  await Promise.all([...sessions.values()].map((acpSession) => acpSession.mcp.close()));
}
