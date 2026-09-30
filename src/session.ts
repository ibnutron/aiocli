import { EventEmitter } from 'node:events';
import Anthropic from '@anthropic-ai/sdk';
import { TOOL_SCHEMAS, executeTool, type ConfirmFn } from './tools/index.js';
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

  /** `/clear`: a new, empty conversation (the old one stays saved for /resume). */
  startNew(): void {
    this.assertIdle();
    this.id = generateSessionId();
    this.createdAt = new Date().toISOString();
    this.history = [];
    this.sessionTitle = undefined;
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
    while (true) {
      let response: ModelResponse;
      try {
        response = await this.client.create(
          {
            model: this.model,
            max_tokens: MAX_OUTPUT_TOKENS,
            system: buildSystemPrompt(this.workspaceRoot, { planMode: this.currentMode() === 'plan' }),
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
        this.emit('tool', { name: block.name, input: block.input });
        let content: string;
        try {
          content = await executeTool(block.name, block.input as Record<string, unknown>, {
            workspaceRoot: this.workspaceRoot,
            confirm: this.confirm,
            signal,
            mcp: this.mcp,
          });
        } catch (error) {
          content = `Error: ${error instanceof Error ? error.message : String(error)}`;
        }
        if (signal.aborted) {
          content = `${content}\n(interrupted by the user)`;
        }
        this.emit('tool_result', { name: block.name, result: content });
        toolResults.push({ type: 'tool_result', tool_use_id: block.id, content });
      }

      this.history.push({ role: 'user', content: toolResults });
      this.persist();
      signal.throwIfAborted();
    }
  }

  private tools(): Anthropic.Tool[] {
    return this.mcp ? [...TOOL_SCHEMAS, ...this.mcp.toolSchemas] : TOOL_SCHEMAS;
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
    this.persist();
    this.emit('compact_end', { trigger, ok: true });
  }

  private async summarize(messages: MessageParam[], instructions?: string, signal?: AbortSignal): Promise<string> {
    const request = [COMPACT_INSTRUCTIONS, instructions ? `\nAlso: ${instructions}` : ''].join('');
    const last = messages[messages.length - 1];
    // End with one user message that asks for the summary (merged into trailing tool results).
    const withRequest: MessageParam[] =
      last?.role === 'user'
        ? [
            ...messages.slice(0, -1),
            {
              role: 'user',
              content: [
                ...(typeof last.content === 'string' ? [{ type: 'text' as const, text: last.content }] : last.content),
                { type: 'text' as const, text: request },
              ],
            },
          ]
        : [...messages, { role: 'user', content: request }];
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
