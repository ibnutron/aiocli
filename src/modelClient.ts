import { randomBytes } from 'node:crypto';
import Anthropic from '@anthropic-ai/sdk';
import { readAuth, serverUrl } from './config.js';
import { authHeaders, providerCredentials, providerDef } from './providers.js';
import { expiredMessage } from './loginStatus.js';
import { log } from './log.js';

type MessageParam = Anthropic.MessageParam;

export interface ModelRequest {
  model: string;
  max_tokens: number;
  /** Omitted for plain questions (the auto-mode permission check). */
  tools?: Anthropic.Tool[];
  system?: string;
  messages: MessageParam[];
}

export interface ModelResponse {
  content: Anthropic.ContentBlock[];
  stop_reason: string | null;
  /** Prompt size of this request, when the provider reports it (drives auto-compaction). */
  usage?: { input_tokens: number; output_tokens: number };
}

/** Receives the answer's text while it is generated (the request is then streamed). */
export type TextListener = (text: string) => void;

/**
 * One model provider behind the CLI's internal (Anthropic Messages) format.
 * `viaAiolah` = calls go through the aiolah proxy with the login token.
 * With `onText`, the request is streamed and the text arrives as it is
 * generated; the promise still resolves to the whole response.
 */
export interface ModelClient {
  readonly provider: string;
  readonly viaAiolah: boolean;
  create(
    request: ModelRequest,
    headers?: Record<string, string>,
    signal?: AbortSignal,
    onText?: TextListener,
  ): Promise<ModelResponse>;
}

/** Logs every model request: provider, model, duration, prompt size, and errors. */
function withLogging(client: ModelClient): ModelClient {
  return {
    provider: client.provider,
    viaAiolah: client.viaAiolah,
    async create(request, headers, signal, onText) {
      const started = Date.now();
      const purpose = headers?.['X-Aiolah-Purpose'] ?? 'turn';
      try {
        const response = await client.create(request, headers, signal, onText);
        log('INFO', 'model request', {
          provider: client.provider,
          model: request.model,
          purpose,
          stream: Boolean(onText),
          ms: Date.now() - started,
          stop: response.stop_reason,
          input_tokens: response.usage?.input_tokens,
          output_tokens: response.usage?.output_tokens,
        });
        return response;
      } catch (error) {
        log('ERROR', 'model request failed', {
          provider: client.provider,
          model: request.model,
          purpose,
          ms: Date.now() - started,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    },
  };
}

export function createModelClient(provider: string): ModelClient {
  return withLogging(createUnloggedClient(provider));
}

function createUnloggedClient(provider: string): ModelClient {
  const def = providerDef(provider);

  if (def.kind === 'aiolah') {
    const auth = readAuth();
    if (!auth) {
      throw new Error('Not signed in to aiolah. Run `aiolah auth login`, or `aiolah connect` another provider.');
    }
    return anthropicClient(
      provider,
      new Anthropic({ apiKey: null, authToken: auth.token, baseURL: `${serverUrl(auth)}/api/cli/anthropic` }),
      true,
    );
  }

  const { apiKey, baseURL } = providerCredentials(provider);
  if (def.needsKey && !apiKey) {
    throw new Error(
      `No API key for ${def.name}. Run \`aiolah connect ${provider}\`` +
        `${def.envKeys?.length ? ` or set ${def.envKeys[0]}` : ''}.`,
    );
  }

  if (def.kind === 'anthropic') {
    return anthropicClient(provider, new Anthropic({ apiKey: apiKey as string, baseURL }), false);
  }

  if (!baseURL) {
    throw new Error(`${def.name} has no base URL. Run \`aiolah connect ${provider}\`.`);
  }
  return openAiClient(provider, baseURL, apiKey);
}

type CacheControl = { type: 'ephemeral' };
const EPHEMERAL: CacheControl = { type: 'ephemeral' };

/**
 * Anthropic prompt caching: mark the end of the system prompt (tools come before it,
 * so they are cached too) and the end of the latest message. Every turn of the agent
 * loop re-sends the same prefix, so later requests read it from the cache at 10% of
 * the input price. Works the same through the aiolah proxy (Claude models are
 * forwarded as-is; other models drop `cache_control` in the server's translation).
 * The history itself is not modified — markers are added to a copy per request.
 */
export function withPromptCaching(request: ModelRequest): Anthropic.MessageCreateParamsNonStreaming {
  const system = request.system ? [{ type: 'text' as const, text: request.system, cache_control: EPHEMERAL }] : undefined;

  const messages = request.messages.map((message, index) => {
    if (index !== request.messages.length - 1) {
      return message;
    }
    if (typeof message.content === 'string') {
      return { ...message, content: [{ type: 'text' as const, text: message.content, cache_control: EPHEMERAL }] };
    }
    const blocks = [...message.content];
    const last = blocks[blocks.length - 1] as { type: string } | undefined;
    // Thinking blocks cannot carry cache_control.
    if (last && last.type !== 'thinking' && last.type !== 'redacted_thinking') {
      blocks[blocks.length - 1] = { ...last, cache_control: EPHEMERAL } as (typeof blocks)[number];
    }
    return { ...message, content: blocks };
  });

  return { ...request, ...(system ? { system } : {}), messages } as Anthropic.MessageCreateParamsNonStreaming;
}

/** Full prompt size: with caching, `input_tokens` only counts the uncached part. */
function promptTokens(usage: { input_tokens?: number; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null }): number {
  return (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
}

function anthropicClient(provider: string, client: Anthropic, viaAiolah: boolean): ModelClient {
  return {
    provider,
    viaAiolah,
    async create(request, headers, signal, onText) {
      const options = { ...(headers ? { headers } : {}), signal };
      // The auto-mode permission check is a tiny one-off prompt (and the proxy only accepts a plain system string there).
      const body = headers?.['X-Aiolah-Purpose'] === 'permission-check' ? request : withPromptCaching(request);
      try {
        if (!onText) {
          const response = await client.messages.create(body, options);
          return {
            content: response.content,
            stop_reason: response.stop_reason,
            usage: { input_tokens: promptTokens(response.usage), output_tokens: response.usage.output_tokens },
          };
        }
        const stream = client.messages.stream(body, options);
        // The aiolah proxy can only report the prompt size at the end (in message_delta).
        let lateInputTokens = 0;
        // This SDK version drops thinking_delta/signature_delta when it assembles the message,
        // and a thinking block sent back without them is rejected: collect them here.
        const thinking = new Map<number, { thinking: string; signature: string }>();
        stream.on('text', (text) => onText(text));
        stream.on('streamEvent', (event) => {
          if (event.type === 'message_delta') {
            lateInputTokens = (event.usage as { input_tokens?: number }).input_tokens ?? 0;
          } else if (event.type === 'content_block_delta') {
            const delta = event.delta as { type: string; thinking?: string; signature?: string };
            if (delta.type === 'thinking_delta' || delta.type === 'signature_delta') {
              const entry = thinking.get(event.index) ?? { thinking: '', signature: '' };
              entry.thinking += delta.thinking ?? '';
              entry.signature += delta.signature ?? '';
              thinking.set(event.index, entry);
            }
          }
        });
        const response = await stream.finalMessage();
        for (const [index, entry] of thinking) {
          const block = response.content[index] as { type: string; thinking?: string; signature?: string } | undefined;
          if (block?.type === 'thinking') {
            block.thinking = (block.thinking ?? '') + entry.thinking;
            block.signature = (block.signature ?? '') + entry.signature;
          }
        }
        return {
          content: response.content,
          stop_reason: response.stop_reason,
          usage: {
            input_tokens: promptTokens(response.usage) || lateInputTokens,
            output_tokens: response.usage.output_tokens,
          },
        };
      } catch (error) {
        // The aiolah login ran out (or was revoked): say so instead of a bare 401.
        if (viaAiolah && error instanceof Anthropic.AuthenticationError) {
          throw new Error(expiredMessage());
        }
        throw error;
      }
    },
  };
}

function openAiClient(provider: string, baseURL: string, apiKey?: string): ModelClient {
  return {
    provider,
    viaAiolah: false,
    async create(request, _headers, signal, onText) {
      const response = await fetch(`${baseURL}/chat/completions`, {
        method: 'POST',
        signal,
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          ...(apiKey ? authHeaders(providerDef(provider), apiKey) : {}),
          // OpenRouter attribution headers; ignored by other providers.
          'HTTP-Referer': 'https://aiolah.com',
          'X-Title': 'aiolah CLI',
        },
        body: JSON.stringify({
          ...toOpenAiRequest(request),
          ...(onText ? { stream: true, stream_options: { include_usage: true } } : {}),
        }),
      });

      if (onText && response.ok && response.body && /event-stream/.test(response.headers.get('content-type') ?? '')) {
        return toAnthropicResponse(await readOpenAiStream(response.body, onText, providerDef(provider).name));
      }

      const text = await response.text();
      let body: OpenAiResponse;
      try {
        body = JSON.parse(text) as OpenAiResponse;
      } catch {
        throw new Error(`${providerDef(provider).name} returned HTTP ${response.status}: ${text.slice(0, 200)}`);
      }
      // Some gateways (OpenRouter) answer 200 with an error body.
      if (!response.ok || !body.choices?.length) {
        const message = body.error?.message ?? `HTTP ${response.status}`;
        throw new Error(`${providerDef(provider).name}: ${message}`);
      }
      return toAnthropicResponse(body);
    },
  };
}

/**
 * Reads a streamed Chat Completions answer (SSE `data:` chunks), passing text
 * on as it arrives, and assembles it into the shape of a non-streamed answer.
 */
async function readOpenAiStream(
  body: ReadableStream<Uint8Array>,
  onText: TextListener,
  providerName: string,
): Promise<OpenAiResponse> {
  let content = '';
  let finishReason: string | undefined;
  let usage: OpenAiResponse['usage'];
  const toolCalls: { id?: string; function: { name: string; arguments: string } }[] = [];
  const decoder = new TextDecoder();
  let buffer = '';

  const handle = (data: string) => {
    if (data.trim() === '[DONE]') return;
    let chunk: OpenAiStreamChunk;
    try {
      chunk = JSON.parse(data) as OpenAiStreamChunk;
    } catch {
      return;
    }
    if (chunk.error) {
      throw new Error(`${providerName}: ${chunk.error.message ?? 'the stream failed'}`);
    }
    if (chunk.usage) usage = chunk.usage;
    const choice = chunk.choices?.[0];
    if (!choice) return;
    if (choice.finish_reason) finishReason = choice.finish_reason;
    if (choice.delta?.content) {
      content += choice.delta.content;
      onText(choice.delta.content);
    }
    for (const [position, call] of (choice.delta?.tool_calls ?? []).entries()) {
      const slot = (toolCalls[call.index ?? position] ??= { function: { name: '', arguments: '' } });
      if (call.id) slot.id = call.id;
      if (call.function?.name) slot.function.name += call.function.name;
      if (call.function?.arguments) slot.function.arguments += call.function.arguments;
    }
  };

  const reader = body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done }).replace(/\r\n/g, '\n');
    let end: number;
    while ((end = buffer.indexOf('\n\n')) !== -1 || (done && buffer.trim())) {
      const block = end === -1 ? buffer : buffer.slice(0, end);
      buffer = end === -1 ? '' : buffer.slice(end + 2);
      const data = block
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).replace(/^ /, ''))
        .join('\n');
      if (data) handle(data);
    }
    if (done) break;
  }

  if (!content && !toolCalls.length && !finishReason) {
    throw new Error(`${providerName}: the model returned no answer`);
  }
  return {
    choices: [
      {
        finish_reason: finishReason,
        message: {
          content,
          tool_calls: toolCalls.filter(Boolean).map((call) => ({ type: 'function', ...call })),
        },
      },
    ],
    usage,
  };
}

interface OpenAiStreamChunk {
  choices?: {
    finish_reason?: string | null;
    delta?: {
      content?: string | null;
      tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[];
    };
  }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string };
}

interface OpenAiToolCall {
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

interface OpenAiResponse {
  choices?: { finish_reason?: string; message?: { content?: string | null; tool_calls?: OpenAiToolCall[] } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string };
}

type OpenAiMessage =
  | { role: 'system' | 'user'; content: string | { type: string; [key: string]: unknown }[] }
  | {
      role: 'assistant';
      content: string | null;
      tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[];
    }
  | { role: 'tool'; tool_call_id: string; content: string };

function flattenText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((block): block is { type: 'text'; text: string } => block?.type === 'text')
    .map((block) => block.text)
    .join('\n');
}

/** Anthropic Messages request → OpenAI Chat Completions request (text, images, tool calls/results). */
export function toOpenAiRequest(request: ModelRequest): Record<string, unknown> {
  const messages: OpenAiMessage[] = request.system ? [{ role: 'system', content: request.system }] : [];

  for (const message of request.messages) {
    if (typeof message.content === 'string') {
      messages.push({ role: message.role, content: message.content } as OpenAiMessage);
      continue;
    }

    if (message.role === 'assistant') {
      const text = flattenText(message.content);
      const toolCalls = message.content
        .filter((block): block is Anthropic.ToolUseBlockParam => block.type === 'tool_use')
        .map((block) => ({
          id: block.id,
          type: 'function' as const,
          function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) },
        }));
      messages.push({
        role: 'assistant',
        content: text || null,
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      });
      continue;
    }

    // Tool results become `role: tool` messages and must precede the user's text of the same turn.
    const parts: { type: string; [key: string]: unknown }[] = [];
    for (const block of message.content) {
      if (block.type === 'tool_result') {
        messages.push({ role: 'tool', tool_call_id: block.tool_use_id, content: flattenText(block.content) });
      } else if (block.type === 'text') {
        parts.push({ type: 'text', text: block.text });
      } else if (block.type === 'image' && block.source.type === 'base64') {
        parts.push({
          type: 'image_url',
          image_url: { url: `data:${block.source.media_type};base64,${block.source.data}` },
        });
      }
    }
    if (parts.length) {
      const onlyText = parts.every((part) => part.type === 'text');
      messages.push({ role: 'user', content: onlyText ? parts.map((part) => part.text as string).join('\n') : parts });
    }
  }

  return {
    model: request.model,
    max_tokens: request.max_tokens,
    messages,
    ...(request.tools?.length
      ? {
          tools: request.tools.map((tool) => ({
            type: 'function',
            function: { name: tool.name, description: tool.description, parameters: tool.input_schema },
          })),
        }
      : {}),
  };
}

/** OpenAI Chat Completions response → Anthropic content blocks + stop reason. */
export function toAnthropicResponse(body: OpenAiResponse): ModelResponse {
  const choice = body.choices?.[0] ?? {};
  const content: Anthropic.ContentBlock[] = [];

  const text = choice.message?.content ?? '';
  if (text.trim()) {
    content.push({ type: 'text', text, citations: null } as Anthropic.TextBlock);
  }
  for (const call of choice.message?.tool_calls ?? []) {
    let input: unknown = {};
    try {
      input = JSON.parse(call.function?.arguments || '{}');
    } catch {
      input = {};
    }
    content.push({
      type: 'tool_use',
      id: call.id || `toolu_${randomBytes(12).toString('hex')}`,
      name: call.function?.name ?? '',
      input,
    } as Anthropic.ToolUseBlock);
  }

  const hasToolCalls = (choice.message?.tool_calls?.length ?? 0) > 0;
  return {
    content,
    stop_reason: hasToolCalls ? 'tool_use' : choice.finish_reason === 'length' ? 'max_tokens' : 'end_turn',
    ...(body.usage
      ? {
          usage: {
            input_tokens: Number(body.usage.prompt_tokens ?? 0),
            output_tokens: Number(body.usage.completion_tokens ?? 0),
          },
        }
      : {}),
  };
}
