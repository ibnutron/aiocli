import { EventEmitter } from 'node:events';
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { resolveInWorkspace } from './tools/fileTools.js';
import Anthropic from '@anthropic-ai/sdk';
import { TOOL_SCHEMAS, USE_SKILL_SCHEMA, executeTool, type ConfirmFn } from './tools/index.js';
import { loadCustomCommands } from './customCommands.js';
import { loadAgents, taskToolSchema, type AgentDefinition } from './agents.js';
import { runHooks } from './hooks.js';
import { generateSessionId, loadSession, saveSession, type SessionRecord } from './persistence.js';
import { createModelClient, type ModelClient, type ModelResponse } from './modelClient.js';
import { packageVersion } from './version.js';
import type { HistoryItem, ImageInput } from './protocol.js';
import type { McpManager } from './mcp/manager.js';
import { reviewWithModel, type AutoVerdict } from './autoMode.js';
import { decidePermission, type PermissionMode } from './permissions.js';
import { buildSystemPrompt } from './instructions.js';

type MessageParam = Anthropic.MessageParam;

export interface ChatTurnResult {
  reply: string;
}

/** Thrown by `send` when the turn was stopped with `interrupt()`. */
export class TurnInterruptedError extends Error {
  constructor() {
    super('Interrupted');
    this.name = 'TurnInterruptedError';
  }
}

const INTERRUPTED_TOOL_RESULT = 'Interrupted by the user before this ran.';
/** Tool calls one subagent may make before it has to report. */
const SUBAGENT_MAX_STEPS = 40;
/** How often a Stop hook may send the agent back to work in one turn. */
const MAX_STOP_HOOK_ROUNDS = 3;

/** A point /rewind can go back to: the start of one user turn. */
interface Checkpoint {
  /** History length before the prompt; -1 once compaction rewrote the history (code-only rewind). */
  historyLength: number;
  prompt: string;
  at: Date;
  /** Files changed by write_file / edit_file in this turn → their content before (null = did not exist). */
  files: Map<string, string | null>;
}

export interface CheckpointInfo {
  index: number;
  prompt: string;
  at: Date;
  files: number;
  conversation: boolean;
}

/** Ends `messages` with a user message carrying `text` (merged into trailing tool results). */
function withUserText(messages: MessageParam[], text: string): MessageParam[] {
  const last = messages[messages.length - 1];
  if (last?.role !== 'user') {
    return [...messages, { role: 'user', content: text }];
  }
  return [
    ...messages.slice(0, -1),
    {
      role: 'user',
      content: [
        ...(typeof last.content === 'string' ? [{ type: 'text' as const, text: last.content }] : last.content),
        { type: 'text' as const, text },
      ],
    },
  ];
}

const MAX_OUTPUT_TOKENS = 4096;
const CHARS_PER_TOKEN = 4;
/** Context window assumed when the model's is unknown; AIOLAH_CONTEXT_WINDOW overrides it. */
const DEFAULT_CONTEXT_WINDOW = 128_000;
/** Share of the context window after which the next turn starts by compacting. */
const AUTO_COMPACT_RATIO = 0.8;

const COMPACT_PREAMBLE = 'This session continues an earlier conversation. Summary of what happened so far:';

const COMPACT_INSTRUCTIONS = [
  'Summarize our conversation so far so that the work can continue from the summary alone. Include:',
  "- the user's requests and intent, in order, and any preferences or constraints they stated;",
  '- key decisions and why they were made;',
  '- files read or changed (with paths) and what was changed;',
  '- commands run and results that matter, errors met and how they were fixed;',
  '- the current state and the next steps still open.',
  'Be specific (names, paths, values) and concise. Reply with the summary only.',
].join('\n');

function autoCompactThreshold(): number {
  const window = Number(process.env.AIOLAH_CONTEXT_WINDOW) || DEFAULT_CONTEXT_WINDOW;
  return Math.floor(window * AUTO_COMPACT_RATIO);
}

const CONTEXT_OVERFLOW_PATTERNS = [
  /context[ _-]?(length|window|limit)/i,
  /prompt is too long|too many tokens|maximum context|token limit|reduce the length/i,
  /exceeds? the (maximum|limit)/i,
];

/** Provider errors that mean "the conversation is too long for this model". */
export function isContextOverflow(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return CONTEXT_OVERFLOW_PATTERNS.some((pattern) => pattern.test(message));
}

/** The second half of a conversation, starting at a user message that isn't a tool result. */
function laterHalf(messages: MessageParam[]): MessageParam[] {
  for (let index = Math.floor(messages.length / 2); index < messages.length; index += 1) {
    const message = messages[index]!;
    if (
      message.role === 'user' &&
      (typeof message.content === 'string' || !message.content.some((block) => block.type === 'tool_result'))
    ) {
      return messages.slice(index);
    }
  }
  return messages.slice(-1);
}

/**
 * Where a prompt came from, sent to aiolah (which logs every prompt it
 * processes): typed on the host, sent from /code / the app / VS Code, or
 * `aiolah run`.
 */
export type PromptOrigin = 'terminal' | 'remote' | 'script';

export interface ChatSessionOptions {
  /** Provider id (see providers.ts), e.g. `aiolah`, `anthropic`, `openrouter`. */
  provider: string;
  model: string;
  workspaceRoot: string;
  /** Asks the user (terminal, remote client) — only called when the permission mode doesn't decide. */
  confirm: ConfirmFn;
  /** Permission mode, read on every action (chat can switch it mid-session). Default: `default`. */
  permissionMode?: PermissionMode | (() => PermissionMode);
  resumeId?: string;
  /** MCP servers whose tools are offered next to the built-in ones. */
  mcp?: McpManager;
}

/**
 * Holds the running conversation for one chat session, drives the
 * tool-call loop against the Anthropic API, and persists history to disk
 * after every turn. Shared by the local `chat` command and the `serve`
 * command so a remote `attach` client sees the exact same conversation.
 *
 * Events, so a host UI, a `serve` broadcaster or the aiolah session sync can
 * follow along: `turn_start` { text, origin }, `tool` { name, input },
 * `tool_result` { name, result }, `confirm_wait` / `confirm_done` (an
 * Allow/Deny prompt is open / answered), `turn_end` { reply } and
 * `turn_error` { message }.
 */
export class ChatSession extends EventEmitter {
  private client: ModelClient;
  /** Device id on aiolah once `serve`/`rc` has registered it; sent with each prompt. */
  hostId?: number;
  private model: string;
  private readonly workspaceRoot: string;
  private readonly confirm: ConfirmFn;
  private readonly mcp?: McpManager;
  private id: string;
  private createdAt: string;
  private history: MessageParam[];
  /** Prompt size of the last request (from the provider's usage), 0 when unknown. */
  private lastInputTokens = 0;
  private readonly currentMode: () => PermissionMode;
  /** Set by /rename; shown on /code and in /resume. */
  private sessionTitle: string | undefined;
  private checkpoints: Checkpoint[] = [];
  /** Output of SessionStart hooks, added to the system prompt. */
  private sessionContext = '';
  /** Directories added with /add-dir or --add-dir. */
  private readonly extraDirs: string[] = [];
  /** Model requests and tokens used by this conversation since the chat started (/cost). */
  readonly usage = { requests: 0, inputTokens: 0, outputTokens: 0 };
  private abortController: AbortController | null = null;
  /** aiolah context headers of the running turn (reused by auto-mode reviews). */
  private turnHeaders: Record<string, string> | undefined;

  constructor(options: ChatSessionOptions) {
    super();
    this.client = createModelClient(options.provider);
    this.model = options.model;
    this.workspaceRoot = options.workspaceRoot;
    this.mcp = options.mcp;
    const mode = options.permissionMode;
    this.currentMode = typeof mode === 'function' ? mode : () => mode ?? 'default';
    this.confirm = async (description, tool) => {
      const decision = await decidePermission(
        this.currentMode(),
        description,
        tool,
        (action) => this.reviewAction(action),
        this.workspaceRoot,
      );
      if (decision.allow) {
        return true;
      }
      if ('deny' in decision) {
        // Refused without asking (plan mode, a deny rule): the tool call fails with the reason.
        throw new Error(decision.deny);
      }
      this.emit('confirm_wait', { description: decision.ask, tool });
      try {
        return await options.confirm(decision.ask, tool);
      } finally {
        this.emit('confirm_done', { description: decision.ask, tool });
      }
    };

    if (options.resumeId) {
      const record = loadSession(options.resumeId);
      this.id = record.id;
      this.createdAt = record.createdAt;
      this.history = record.history;
      this.sessionTitle = record.title;
    } else {
      this.id = generateSessionId();
      this.createdAt = new Date().toISOString();
      this.history = [];
    }
  }

  get sessionId(): string {
    return this.id;
  }

  get modelId(): string {
    return this.model;
  }

  get providerId(): string {
    return this.client.provider;
  }

  /** Switch provider/model mid-session; the history carries over (it is provider-neutral). */
  useModel(provider: string, model: string): void {
    this.client = createModelClient(provider);
    this.model = model;
  }

  get workspace(): string {
    return this.workspaceRoot;
  }

  /** Tokens the conversation takes: the last reported prompt size, or an estimate. */
  get contextTokens(): number {
    return this.lastInputTokens || Math.round(JSON.stringify(this.history).length / CHARS_PER_TOKEN);
  }

  get title(): string | undefined {
    return this.sessionTitle;
  }

  /** `/rename`: names the conversation (saved locally; SessionSync sends it to /code). */
  rename(title: string): void {
    this.sessionTitle = title.trim().slice(0, 120) || undefined;
    this.persist();
    this.emit('renamed', { title: this.sessionTitle });
  }

  get additionalDirectories(): string[] {
    return [...this.extraDirs];
  }

  /** `/add-dir`: lets the tools read and change files in another directory too. */
  addDir(path: string): string {
    const absolute = resolvePath(this.workspaceRoot, path);
    if (!existsSync(absolute) || !statSync(absolute).isDirectory()) {
      throw new Error(`Not a directory: ${absolute}`);
    }
    if (absolute !== resolvePath(this.workspaceRoot) && !this.extraDirs.includes(absolute)) {
      this.extraDirs.push(absolute);
    }
    return absolute;
  }

  /** `/fork`: continue in a copy of this conversation; the original stays saved for /resume. */
  fork(): string {
    this.assertIdle();
    const original = this.id;
    this.id = generateSessionId();
    this.createdAt = new Date().toISOString();
    this.sessionTitle = this.sessionTitle ? `${this.sessionTitle} (fork)`.slice(0, 120) : undefined;
    this.checkpoints = [];
    this.persist();
    this.emit('session_changed', { reason: 'fork', from: original });
    return original;
  }

  /**
   * `/btw`: a side question answered from the conversation so far, without
   * tools and without adding it to the history.
   */
  async aside(question: string): Promise<string> {
    const response = await this.client.create(
      {
        model: this.model,
        max_tokens: MAX_OUTPUT_TOKENS,
        system:
          `${buildSystemPrompt(this.workspaceRoot)}\n\nThis is a quick side question from the user. ` +
          'Answer it briefly from what you already know in this conversation; do not call tools.',
        tools: this.tools(),
        messages: withUserText(this.history, question),
      },
      this.client.viaAiolah
        ? { ...(this.turnHeaders ?? { 'X-Aiolah-Session': this.id }), 'X-Aiolah-Purpose': 'btw' }
        : undefined,
    );
    this.usage.requests += 1;
    this.usage.inputTokens += response.usage?.input_tokens ?? 0;
    this.usage.outputTokens += response.usage?.output_tokens ?? 0;
    return response.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('\n')
      .trim();
  }

  /** The turns /rewind can go back to, oldest first. */
  listCheckpoints(): CheckpointInfo[] {
    return this.checkpoints.map((checkpoint, index) => ({
      index,
      prompt: checkpoint.prompt,
      at: checkpoint.at,
      files: checkpoint.files.size,
      conversation: checkpoint.historyLength >= 0,
    }));
  }

  /**
   * `/rewind`: back to before the prompt of checkpoint `index` — the files
   * write_file / edit_file changed since then, the conversation, or both.
   * Changes made by shell commands are not tracked.
   */
  rewind(index: number, what: 'both' | 'code' | 'conversation'): { files: number; prompt: string } {
    this.assertIdle();
    const target = this.checkpoints[index];
    if (!target) {
      throw new Error('No such checkpoint.');
    }
    if (what !== 'code' && target.historyLength < 0) {
      throw new Error('The conversation was compacted after this point; only the code can be restored.');
    }
    let files = 0;
    if (what !== 'conversation') {
      for (const checkpoint of this.checkpoints.slice(index).reverse()) {
        for (const [path, original] of checkpoint.files) {
          if (original === null) {
            rmSync(path, { force: true });
          } else {
            writeFileSync(path, original, 'utf8');
          }
          files += 1;
        }
        checkpoint.files.clear();
      }
    }
    if (what !== 'code') {
      this.history = this.history.slice(0, target.historyLength);
      this.checkpoints = this.checkpoints.slice(0, index);
      this.lastInputTokens = 0;
      this.persist();
    }
    this.emit('rewound', { what, files });
    return { files, prompt: target.prompt };
  }

  /** Remembers a file's content before write_file / edit_file changes it in this turn. */
  private snapshotBeforeChange(input: Record<string, unknown>): void {
    const checkpoint = this.checkpoints[this.checkpoints.length - 1];
    if (!checkpoint || typeof input.path !== 'string') {
      return;
    }
    let absolute: string;
    try {
      absolute = resolveInWorkspace([this.workspaceRoot, ...this.extraDirs], input.path);
    } catch {
      return;
    }
    if (!checkpoint.files.has(absolute)) {
      checkpoint.files.set(absolute, existsSync(absolute) ? readFileSync(absolute, 'utf8') : null);
    }
  }

  /** `/clear`: a new, empty conversation (the old one stays saved for /resume). */
  startNew(): void {
    this.assertIdle();
    this.id = generateSessionId();
    this.createdAt = new Date().toISOString();
    this.history = [];
    this.sessionTitle = undefined;
    this.checkpoints = [];
    this.lastInputTokens = 0;
    this.emit('session_changed', { reason: 'new' });
  }

  /** `/resume`: continue a saved conversation in this chat. */
  resume(id: string): void {
    this.assertIdle();
    const record = loadSession(id);
    this.id = record.id;
    this.createdAt = record.createdAt;
    this.history = record.history;
    this.sessionTitle = record.title;
    this.checkpoints = [];
    this.lastInputTokens = 0;
    this.emit('session_changed', { reason: 'resume' });
  }

  /**
   * `/compact`: replaces the conversation with a summary written by the model,
   * so a long session keeps working within the model's context window.
   */
  async compact(instructions?: string): Promise<{ before: number; after: number }> {
    this.assertIdle();
    if (!this.history.length) {
      return { before: 0, after: 0 };
    }
    const before = this.contextTokens;
    await this.compactHistory(false, instructions);
    return { before, after: this.contextTokens };
  }

  private assertIdle(): void {
    if (this.abortController) {
      throw new Error('Wait for the current turn to finish (or press Esc).');
    }
  }

  /** True while a turn is running. */
  get isRunning(): boolean {
    return this.abortController !== null;
  }

  /** Stops the running turn (model call, pending shell command); `send` then throws TurnInterruptedError. */
  interrupt(): boolean {
    if (!this.abortController) {
      return false;
    }
    this.abortController.abort();
    return true;
  }

  /** Conversation flattened to what a client renders (tool_use/tool_result pairs joined by id). */
  renderHistory(): HistoryItem[] {
    const items: HistoryItem[] = [];
    const pendingTools = new Map<string, { name: string; input: unknown }>();

    for (const message of this.history) {
      if (typeof message.content === 'string') {
        items.push({ role: message.role, text: message.content });
        continue;
      }

      const images = message.content.filter((block) => block.type === 'image').length;
      let imagesShown = false;
      for (const block of message.content) {
        if (block.type === 'text' && block.text.trim()) {
          if (message.role === 'user' && images && !imagesShown) {
            items.push({ role: 'user', text: block.text, images });
            imagesShown = true;
          } else {
            items.push({ role: message.role, text: block.text });
          }
        } else if (block.type === 'tool_use') {
          pendingTools.set(block.id, { name: block.name, input: block.input });
        } else if (block.type === 'tool_result') {
          const call = pendingTools.get(block.tool_use_id);
          const result =
            typeof block.content === 'string'
              ? block.content
              : (block.content ?? []).map((part) => (part.type === 'text' ? part.text : '')).join('');
          items.push({ role: 'tool', name: call?.name ?? 'unknown', input: call?.input, result });
          pendingTools.delete(block.tool_use_id);
        }
      }
    }

    return items;
  }

  async send(
    userMessage: string,
    origin: PromptOrigin = 'terminal',
    images: ImageInput[] = [],
  ): Promise<ChatTurnResult> {
    if (this.abortController) {
      throw new Error('A turn is already running.');
    }
    const controller = new AbortController();
    this.abortController = controller;
    this.emit('turn_start', { text: userMessage, origin, images: images.length });
    try {
      const result = await this.runTurn(userMessage, origin, images, controller.signal);
      this.emit('turn_end', { reply: result.reply });
      return result;
    } catch (error) {
      if (controller.signal.aborted) {
        this.closeInterruptedTurn();
        this.emit('turn_error', { message: 'Interrupted' });
        throw new TurnInterruptedError();
      }
      this.emit('turn_error', { message: error instanceof Error ? error.message : String(error) });
      throw error;
    } finally {
      this.abortController = null;
    }
  }

  /**
   * Leaves the history valid for the next request after an interrupt: every
   * tool_use gets a tool_result, and the turn ends with an assistant message.
   */
  private closeInterruptedTurn(): void {
    const last = this.history[this.history.length - 1];
    if (last?.role === 'assistant' && Array.isArray(last.content)) {
      const pending = last.content.filter((block): block is Anthropic.ToolUseBlockParam => block.type === 'tool_use');
      if (pending.length) {
        this.history.push({
          role: 'user',
          content: pending.map((block) => ({
            type: 'tool_result',
            tool_use_id: block.id,
            content: INTERRUPTED_TOOL_RESULT,
          })),
        });
      }
    }
    if (this.history[this.history.length - 1]?.role !== 'assistant') {
      this.history.push({ role: 'assistant', content: '(interrupted)' });
    }
    this.persist();
  }

  private async runTurn(
    userMessage: string,
    origin: PromptOrigin,
    images: ImageInput[],
    signal: AbortSignal,
  ): Promise<ChatTurnResult> {
    // Near the context limit: summarize before adding more.
    if (this.history.length && this.contextTokens > autoCompactThreshold()) {
      await this.compactHistory(false, undefined, signal, 'auto');
    }

    const promptHook = await runHooks(this.workspaceRoot, 'UserPromptSubmit', {
      session_id: this.id,
      prompt: userMessage,
    });
    this.reportHookErrors(promptHook.errors);
    if (promptHook.blocked) {
      throw new Error(`Blocked by a UserPromptSubmit hook: ${promptHook.reason}`);
    }
    if (promptHook.context) {
      userMessage = `${userMessage}\n\n${promptHook.context}`;
    }

    this.checkpoints.push({
      historyLength: this.history.length,
      prompt: userMessage,
      at: new Date(),
      files: new Map(),
    });
    this.history.push({
      role: 'user',
      content: images.length
        ? [
            ...images.map((image) => ({
              type: 'image' as const,
              source: { type: 'base64' as const, media_type: image.media_type, data: image.data },
            })),
            { type: 'text' as const, text: userMessage },
          ]
        : userMessage,
    });

    // Context for aiolah's prompt log; never sent to Anthropic directly.
    const headers = (this.turnHeaders = this.client.viaAiolah
      ? {
          'X-Aiolah-Session': this.id,
          'X-Aiolah-Origin': origin,
          'X-Aiolah-Version': packageVersion(),
          ...(this.hostId ? { 'X-Aiolah-Host': String(this.hostId) } : {}),
        }
      : undefined);

    let compactedForOverflow = false;
    let stopRounds = 0;
    while (true) {
      let response: ModelResponse;
      try {
        response = await this.client.create(
          {
            model: this.model,
            max_tokens: MAX_OUTPUT_TOKENS,
            system:
              buildSystemPrompt(this.workspaceRoot, {
                planMode: this.currentMode() === 'plan',
                extraDirs: this.extraDirs,
              }) + (this.sessionContext ? `\n\nSession context from hooks:\n${this.sessionContext}` : ''),
            tools: this.tools(),
            messages: this.history,
          },
          headers,
          signal,
        );
      } catch (error) {
        // The conversation no longer fits: summarize it once and try again.
        if (!compactedForOverflow && !signal.aborted && isContextOverflow(error) && this.history.length > 1) {
          compactedForOverflow = true;
          await this.compactHistory(true, undefined, signal, 'overflow');
          continue;
        }
        throw error;
      }
      signal.throwIfAborted();
      if (response.usage?.input_tokens) {
        this.lastInputTokens = response.usage.input_tokens + (response.usage.output_tokens ?? 0);
      }
      this.usage.requests += 1;
      this.usage.inputTokens += response.usage?.input_tokens ?? 0;
      this.usage.outputTokens += response.usage?.output_tokens ?? 0;

      this.history.push({ role: 'assistant', content: response.content });
      this.persist();

      if (response.stop_reason !== 'tool_use') {
        const reply = response.content
          .filter((block): block is Anthropic.TextBlock => block.type === 'text')
          .map((block) => block.text)
          .join('\n');
        // A Stop hook that exits 2 sends the agent back to work with its message.
        if (stopRounds < MAX_STOP_HOOK_ROUNDS) {
          const stop = await runHooks(this.workspaceRoot, 'Stop', {
            session_id: this.id,
            stop_hook_active: stopRounds > 0,
            last_message: reply,
          });
          this.reportHookErrors(stop.errors);
          if (stop.blocked) {
            stopRounds += 1;
            this.history.push({ role: 'user', content: `Stop hook feedback: ${stop.reason}` });
            this.persist();
            continue;
          }
        }
        return { reply };
      }

      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      for (const block of response.content) {
        if (block.type !== 'tool_use') {
          continue;
        }
        if (signal.aborted) {
          toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: INTERRUPTED_TOOL_RESULT });
          continue;
        }
        const content = await this.callTool(block.name, block.input as Record<string, unknown>, signal);
        toolResults.push({ type: 'tool_result', tool_use_id: block.id, content });
      }

      this.history.push({ role: 'user', content: toolResults });
      this.persist();
      signal.throwIfAborted();
    }
  }

  private tools(): Anthropic.Tool[] {
    const hasSkills = loadCustomCommands(this.workspaceRoot).some((command) => command.kind === 'skill');
    return [
      ...TOOL_SCHEMAS,
      taskToolSchema(loadAgents(this.workspaceRoot)),
      ...(hasSkills ? [USE_SKILL_SCHEMA] : []),
      ...(this.mcp?.toolSchemas ?? []),
    ];
  }

  /**
   * Runs one tool call for the main agent or a subagent: PreToolUse hooks
   * (exit 2 blocks it), the checkpoint snapshot, the tool itself (task starts
   * a subagent), then PostToolUse hooks (exit 2 adds feedback to the result).
   */
  private async callTool(
    name: string,
    input: Record<string, unknown>,
    signal: AbortSignal,
    agent?: string,
  ): Promise<string> {
    this.emit('tool', { name, input, agent });
    let content: string;
    const pre = await runHooks(this.workspaceRoot, 'PreToolUse', {
      session_id: this.id,
      tool_name: name,
      tool_input: input,
    });
    this.reportHookErrors(pre.errors);
    if (pre.blocked) {
      content = `Blocked by a PreToolUse hook: ${pre.reason}`;
    } else {
      if (name === 'write_file' || name === 'edit_file') {
        this.snapshotBeforeChange(input);
      }
      try {
        content =
          name === 'task' && !agent
            ? await this.runSubagent(input, signal)
            : await executeTool(name, input, {
                workspaceRoot: this.workspaceRoot,
                confirm: this.confirm,
                signal,
                mcp: this.mcp,
                extraRoots: this.extraDirs,
              });
      } catch (error) {
        content = `Error: ${error instanceof Error ? error.message : String(error)}`;
      }
      const post = await runHooks(this.workspaceRoot, 'PostToolUse', {
        session_id: this.id,
        tool_name: name,
        tool_input: input,
        tool_response: content,
      });
      this.reportHookErrors(post.errors);
      if (post.blocked) {
        content = `${content}\n\nPostToolUse hook feedback: ${post.reason}`;
      }
    }
    if (signal.aborted) {
      content = `${content}\n(interrupted by the user)`;
    }
    this.emit('tool_result', { name, result: content, agent });
    return content;
  }

  /**
   * The `task` tool: runs a subagent in its own context with its own tools
   * (same model, permissions and hooks) and returns its final report.
   */
  private async runSubagent(input: Record<string, unknown>, signal: AbortSignal): Promise<string> {
    const agents = loadAgents(this.workspaceRoot);
    const agent: AgentDefinition | undefined = agents.find((item) => item.name === String(input.subagent_type));
    if (!agent) {
      throw new Error(
        `No agent "${String(input.subagent_type)}". Available: ${agents.map((item) => item.name).join(', ')}`,
      );
    }
    const tools = this.tools().filter(
      (tool) => tool.name !== 'task' && (agent.tools === null || agent.tools.includes(tool.name)),
    );
    const system = [
      buildSystemPrompt(this.workspaceRoot, {
        planMode: this.currentMode() === 'plan',
        extraDirs: this.extraDirs,
      }),
      '',
      `You are the "${agent.name}" subagent, started by the main agent for one task. ${agent.prompt}`,
      'Work only on the task below. End with a concise report of what you found or did; it is all the main agent sees.',
    ].join('\n');
    const messages: MessageParam[] = [{ role: 'user', content: String(input.prompt ?? '') }];
    for (let step = 0; step < SUBAGENT_MAX_STEPS; step += 1) {
      const response = await this.client.create(
        { model: this.model, max_tokens: MAX_OUTPUT_TOKENS, system, tools, messages },
        this.client.viaAiolah
          ? { ...(this.turnHeaders ?? { 'X-Aiolah-Session': this.id }), 'X-Aiolah-Purpose': 'subagent' }
          : undefined,
        signal,
      );
      signal.throwIfAborted();
      this.usage.requests += 1;
      this.usage.inputTokens += response.usage?.input_tokens ?? 0;
      this.usage.outputTokens += response.usage?.output_tokens ?? 0;
      messages.push({ role: 'assistant', content: response.content });
      const text = response.content
        .filter((block): block is Anthropic.TextBlock => block.type === 'text')
        .map((block) => block.text)
        .join('\n')
        .trim();
      if (response.stop_reason !== 'tool_use') {
        return text || '(the subagent finished without a report)';
      }
      const results: Anthropic.ToolResultBlockParam[] = [];
      for (const block of response.content) {
        if (block.type !== 'tool_use') continue;
        const allowed = tools.some((tool) => tool.name === block.name);
        const content = allowed
          ? await this.callTool(block.name, block.input as Record<string, unknown>, signal, agent.name)
          : `Error: the ${agent.name} agent cannot use ${block.name}.`;
        results.push({ type: 'tool_result', tool_use_id: block.id, content });
      }
      messages.push({ role: 'user', content: results });
    }
    return `The ${agent.name} agent stopped after ${SUBAGENT_MAX_STEPS} steps without finishing.`;
  }

  private reportHookErrors(errors: string[]): void {
    for (const message of errors) {
      this.emit('hook_error', { message });
    }
  }

  /** SessionStart hooks (chat and run call this once): their output becomes context for the model. */
  async startSession(source: 'startup' | 'resume'): Promise<void> {
    const result = await runHooks(this.workspaceRoot, 'SessionStart', { session_id: this.id, source });
    this.reportHookErrors(result.errors);
    this.sessionContext = result.context;
  }

  /**
   * Replaces the history with a model-written summary. `midTurn`: the turn is
   * still running (the history ends with tool results), so the summary ends
   * with an instruction to carry on instead of an assistant acknowledgement.
   * If even the summary request is too long, older messages are dropped first.
   */
  private async compactHistory(
    midTurn: boolean,
    instructions?: string,
    signal?: AbortSignal,
    trigger: 'manual' | 'auto' | 'overflow' = 'manual',
  ): Promise<void> {
    this.emit('compact_start', { trigger });
    let messages = this.history;
    let summary = '';
    for (let attempt = 0; attempt < 3 && !summary; attempt += 1) {
      try {
        summary = await this.summarize(messages, instructions, signal);
      } catch (error) {
        if (!isContextOverflow(error)) {
          this.emit('compact_end', { trigger, ok: false });
          throw error;
        }
        messages = laterHalf(messages);
      }
    }
    const note = summary
      ? `${COMPACT_PREAMBLE}\n\n${summary}`
      : 'The earlier part of this conversation was dropped because it no longer fit in the context window.';
    this.history = midTurn
      ? [{ role: 'user', content: `${note}\n\nContinue the current task from where it stopped.` }]
      : [
          { role: 'user', content: note },
          {
            role: 'assistant',
            content: 'Understood — I have the summary of our earlier work and will continue from it.',
          },
        ];
    this.lastInputTokens = 0;
    for (const checkpoint of this.checkpoints) {
      checkpoint.historyLength = -1;
    }
    this.persist();
    this.emit('compact_end', { trigger, ok: true });
  }

  private async summarize(messages: MessageParam[], instructions?: string, signal?: AbortSignal): Promise<string> {
    const request = [COMPACT_INSTRUCTIONS, instructions ? `\nAlso: ${instructions}` : ''].join('');
    const withRequest = withUserText(messages, request);
    const response = await this.client.create(
      {
        model: this.model,
        max_tokens: MAX_OUTPUT_TOKENS,
        system: 'You summarize a coding session so that it can continue with less context. Do not call tools.',
        // Tool definitions are required when the history contains tool calls.
        tools: this.tools(),
        messages: withRequest,
      },
      this.client.viaAiolah
        ? { ...(this.turnHeaders ?? { 'X-Aiolah-Session': this.id }), 'X-Aiolah-Purpose': 'compact' }
        : undefined,
      signal,
    );
    return response.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('\n')
      .trim();
  }

  /** Auto mode: asks the session's model whether `action` may run without the user. */
  private reviewAction(action: string): Promise<AutoVerdict> {
    return reviewWithModel(
      this.client,
      this.model,
      { action, userRequest: this.latestUserRequest(), workspace: this.workspaceRoot },
      this.turnHeaders,
      this.abortController?.signal,
    );
  }

  /** Text of the user's most recent message (not tool results). */
  private latestUserRequest(): string {
    for (let index = this.history.length - 1; index >= 0; index -= 1) {
      const message = this.history[index]!;
      if (message.role !== 'user') {
        continue;
      }
      if (typeof message.content === 'string') {
        return message.content;
      }
      const text = message.content
        .filter((block): block is Anthropic.TextBlockParam => block.type === 'text')
        .map((block) => block.text)
        .join('\n');
      if (text.trim()) {
        return text;
      }
    }
    return '';
  }

  private persist(): void {
    const record: SessionRecord = {
      id: this.id,
      model: this.model,
      workspace: this.workspaceRoot,
      createdAt: this.createdAt,
      updatedAt: new Date().toISOString(),
      provider: this.client.provider,
      history: this.history,
      ...(this.sessionTitle ? { title: this.sessionTitle } : {}),
    };
    saveSession(record);
  }
}
