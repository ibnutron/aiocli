import { randomBytes } from 'node:crypto';
import Anthropic from '@anthropic-ai/sdk';
import { readAuth, serverUrl } from './config.js';
import { authHeaders, providerCredentials, providerDef } from './providers.js';
import { expiredMessage } from './loginStatus.js';

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
}

/**
 * One model provider behind the CLI's internal (Anthropic Messages) format.
 * `viaAiolah` = calls go through the aiolah proxy with the login token.
 */
export interface ModelClient {
  readonly provider: string;
  readonly viaAiolah: boolean;
  create(request: ModelRequest, headers?: Record<string, string>, signal?: AbortSignal): Promise<ModelResponse>;
}

export function createModelClient(provider: string): ModelClient {
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

function anthropicClient(provider: string, client: Anthropic, viaAiolah: boolean): ModelClient {
  return {
    provider,
    viaAiolah,
    async create(request, headers, signal) {
      try {
        const response = await client.messages.create(request, { ...(headers ? { headers } : {}), signal });
        return { content: response.content, stop_reason: response.stop_reason };
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
    async create(request, _headers, signal) {
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
        body: JSON.stringify(toOpenAiRequest(request)),
      });

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

interface OpenAiToolCall {
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

interface OpenAiResponse {
  choices?: { finish_reason?: string; message?: { content?: string | null; tool_calls?: OpenAiToolCall[] } }[];
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
  };
}
