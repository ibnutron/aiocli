import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readAuth } from './config.js';
import { fetchModels } from './models.js';

/**
 * How the CLI talks to a provider:
 * - `aiolah`: your aiolah account (`aiolah auth login`), billed to your plan;
 * - `anthropic`: Anthropic Messages API (Anthropic itself, or a compatible endpoint);
 * - `openai`: any OpenAI-compatible Chat Completions API with your own key
 *   (translated to/from the CLI's internal Anthropic format, tools included).
 */
export type ProviderKind = 'aiolah' | 'anthropic' | 'openai';

export interface ProviderDef {
  id: string;
  name: string;
  kind: ProviderKind;
  /**
   * API base URL. `{NAME}` placeholders (account/resource names) are asked for
   * on connect, or read from the environment variable of the same name.
   */
  baseURL?: string;
  /** Environment variables that also supply the key (first one set wins). */
  envKeys?: string[];
  /** False for providers that need no key (aiolah login, local servers). */
  needsKey: boolean;
  /** Ask for the base URL on connect (local servers, region-specific endpoints); the default is offered. */
  askBaseUrl?: boolean;
  /** Header that carries the key; default `Authorization: Bearer <key>`. */
  authHeader?: 'api-key';
  /** Where to create a key. */
  keyUrl?: string;
  /** Model used when none is chosen (only where the id is stable). */
  defaultModel?: string;
  /** Shown near the top of the connect list. */
  popular?: boolean;
  note?: string;
}

/** OpenAI-compatible provider with an API key. */
function compatible(
  id: string,
  name: string,
  baseURL: string,
  envKeys: string[],
  extra: Partial<ProviderDef> = {},
): ProviderDef {
  return { id, name, kind: 'openai', baseURL, envKeys, needsKey: true, ...extra };
}

/** OpenAI-compatible server on this machine (no key). */
function local(id: string, name: string, baseURL: string): ProviderDef {
  return { id, name, kind: 'openai', baseURL, needsKey: false, askBaseUrl: true };
}

/**
 * Providers `aiolah connect` / `/connect` offers. Base URLs and key variables
 * follow models.dev (the catalog opencode uses) or the provider's own docs.
 */
export const PROVIDERS: ProviderDef[] = [
  { id: 'aiolah', name: 'aiolah', kind: 'aiolah', needsKey: false, popular: true },
  {
    id: 'anthropic',
    name: 'Anthropic',
    kind: 'anthropic',
    baseURL: 'https://api.anthropic.com',
    envKeys: ['ANTHROPIC_API_KEY'],
    needsKey: true,
    keyUrl: 'https://console.anthropic.com/settings/keys',
    defaultModel: 'claude-sonnet-5',
    popular: true,
  },
  compatible('openai', 'OpenAI', 'https://api.openai.com/v1', ['OPENAI_API_KEY'], {
    keyUrl: 'https://platform.openai.com/api-keys',
    popular: true,
  }),
  compatible(
    'google',
    'Google Gemini',
    'https://generativelanguage.googleapis.com/v1beta/openai',
    ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY'],
    { keyUrl: 'https://aistudio.google.com/apikey', popular: true },
  ),
  compatible('openrouter', 'OpenRouter', 'https://openrouter.ai/api/v1', ['OPENROUTER_API_KEY'], {
    keyUrl: 'https://openrouter.ai/settings/keys',
    popular: true,
  }),
  compatible('opencode', 'OpenCode Zen', 'https://opencode.ai/zen/v1', ['OPENCODE_API_KEY'], {
    keyUrl: 'https://opencode.ai/auth',
    popular: true,
    note: 'Zen’s free models only work inside OpenCode; paid models work here.',
  }),
  compatible('xai', 'xAI', 'https://api.x.ai/v1', ['XAI_API_KEY'], { keyUrl: 'https://console.x.ai', popular: true }),
  compatible('deepseek', 'DeepSeek', 'https://api.deepseek.com', ['DEEPSEEK_API_KEY'], {
    keyUrl: 'https://platform.deepseek.com/api_keys',
    popular: true,
  }),
  compatible('302ai', '302.AI', 'https://api.302.ai/v1', ['302AI_API_KEY']),
  compatible(
    'azure',
    'Azure OpenAI',
    'https://{AZURE_RESOURCE_NAME}.openai.azure.com/openai/v1',
    ['AZURE_API_KEY', 'AZURE_OPENAI_API_KEY'],
    { authHeader: 'api-key', note: 'Use your deployment name as the model id.' },
  ),
  {
    id: 'bedrock',
    name: 'Amazon Bedrock (API key)',
    kind: 'openai',
    baseURL: 'https://bedrock-mantle.us-east-1.api.aws/v1',
    envKeys: ['AWS_BEARER_TOKEN_BEDROCK'],
    needsKey: true,
    askBaseUrl: true,
    note: 'Bedrock API key (bearer token); change us-east-1 in the URL for another region.',
  },
  compatible('baseten', 'Baseten', 'https://inference.baseten.co/v1', ['BASETEN_API_KEY']),
  compatible('cerebras', 'Cerebras', 'https://api.cerebras.ai/v1', ['CEREBRAS_API_KEY']),
  compatible(
    'cloudflare-workers-ai',
    'Cloudflare Workers AI',
    'https://api.cloudflare.com/client/v4/accounts/{CLOUDFLARE_ACCOUNT_ID}/ai/v1',
    ['CLOUDFLARE_API_KEY', 'CLOUDFLARE_API_TOKEN'],
  ),
  compatible('cortecs', 'Cortecs', 'https://api.cortecs.ai/v1', ['CORTECS_API_KEY']),
  compatible('deepinfra', 'Deep Infra', 'https://api.deepinfra.com/v1/openai', ['DEEPINFRA_API_KEY']),
  compatible('digitalocean', 'DigitalOcean', 'https://inference.do-ai.run/v1', ['DIGITALOCEAN_ACCESS_TOKEN'], {
    note: 'Use a Model Access Key.',
  }),
  compatible('edenai', 'Eden AI', 'https://api.edenai.run/v3', ['EDENAI_API_KEY'], { askBaseUrl: true }),
  compatible('fireworks', 'Fireworks AI', 'https://api.fireworks.ai/inference/v1', ['FIREWORKS_API_KEY']),
  compatible('frogbot', 'FrogBot', 'https://app.frogbot.ai/api/v1', ['FROGBOT_API_KEY']),
  compatible('gmicloud', 'GMI Cloud', 'https://api.gmi-serving.com/v1', ['GMICLOUD_API_KEY']),
  compatible('groq', 'Groq', 'https://api.groq.com/openai/v1', ['GROQ_API_KEY']),
  compatible('helicone', 'Helicone', 'https://ai-gateway.helicone.ai/v1', ['HELICONE_API_KEY']),
  compatible('huggingface', 'Hugging Face', 'https://router.huggingface.co/v1', ['HF_TOKEN'], {
    keyUrl: 'https://huggingface.co/settings/tokens',
    note: 'The token needs the “Make calls to Inference Providers” permission.',
  }),
  compatible('ionet', 'IO.NET', 'https://api.intelligence.io.solutions/api/v1', ['IOINTELLIGENCE_API_KEY']),
  compatible('llmgateway', 'LLM Gateway', 'https://api.llmgateway.io/v1', ['LLMGATEWAY_API_KEY']),
  {
    id: 'minimax',
    name: 'MiniMax',
    kind: 'anthropic',
    baseURL: 'https://api.minimax.io/anthropic',
    envKeys: ['MINIMAX_API_KEY'],
    needsKey: true,
  },
  compatible('mistral', 'Mistral', 'https://api.mistral.ai/v1', ['MISTRAL_API_KEY']),
  compatible('modal', 'Modal', 'https://inference.us-west.modal.direct/v1', ['MODAL_PROXY_TOKEN'], {
    askBaseUrl: true,
    note: 'Proxy token (wk-…ws-…) of a shared endpoint.',
  }),
  compatible('moonshot', 'Moonshot AI (Kimi)', 'https://api.moonshot.ai/v1', ['MOONSHOT_API_KEY']),
  compatible('nebius', 'Nebius Token Factory', 'https://api.tokenfactory.nebius.com/v1', ['NEBIUS_API_KEY']),
  compatible('nvidia', 'NVIDIA', 'https://integrate.api.nvidia.com/v1', ['NVIDIA_API_KEY'], {
    askBaseUrl: true,
    keyUrl: 'https://build.nvidia.com/',
    note: 'For an on-prem NIM use its URL, e.g. http://localhost:8000/v1.',
  }),
  compatible('ollama-cloud', 'Ollama Cloud', 'https://ollama.com/v1', ['OLLAMA_API_KEY']),
  compatible('ovhcloud', 'OVHcloud AI Endpoints', 'https://oai.endpoints.kepler.ai.cloud.ovh.net/v1', [
    'OVHCLOUD_API_KEY',
  ]),
  compatible('poolside', 'Poolside', 'https://inference.poolside.ai/v1', ['POOLSIDE_API_KEY'], { askBaseUrl: true }),
  compatible('scaleway', 'Scaleway', 'https://api.scaleway.ai/v1', ['SCALEWAY_API_KEY']),
  compatible(
    'snowflake-cortex',
    'Snowflake Cortex',
    'https://{SNOWFLAKE_ACCOUNT}.snowflakecomputing.com/api/v2/cortex/v1',
    ['SNOWFLAKE_CORTEX_PAT', 'SNOWFLAKE_CORTEX_TOKEN'],
    { note: 'Use a programmatic access token (PAT).' },
  ),
  compatible('stackit', 'STACKIT', 'https://api.openai-compat.model-serving.eu01.onstackit.cloud/v1', [
    'STACKIT_API_KEY',
  ]),
  compatible('together', 'Together AI', 'https://api.together.xyz/v1', ['TOGETHER_API_KEY']),
  compatible('venice', 'Venice AI', 'https://api.venice.ai/api/v1', ['VENICE_API_KEY'], {
    keyUrl: 'https://venice.ai/settings/api',
  }),
  compatible('vercel', 'Vercel AI Gateway', 'https://ai-gateway.vercel.sh/v1', ['AI_GATEWAY_API_KEY']),
  compatible('zai', 'Z.AI', 'https://api.z.ai/api/paas/v4', ['ZHIPU_API_KEY', 'ZAI_API_KEY'], {
    keyUrl: 'https://z.ai/manage-apikey/apikey-list',
  }),
  compatible('zai-coding-plan', 'Z.AI Coding Plan', 'https://api.z.ai/api/coding/paas/v4', [
    'ZHIPU_API_KEY',
    'ZAI_API_KEY',
  ]),
  compatible('zenmux', 'ZenMux', 'https://zenmux.ai/api/v1', ['ZENMUX_API_KEY']),
  compatible(
    'dashscope',
    'Alibaba Cloud Model Studio (Qwen)',
    'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
    ['DASHSCOPE_API_KEY'],
    { askBaseUrl: true },
  ),
  compatible('agnes', 'Agnes AI', 'https://apihub.agnes-ai.com/v1', ['AGNES_API_KEY']),
  compatible('featherless', 'Featherless', 'https://api.featherless.ai/v1', ['FEATHERLESS_API_KEY']),
  local('ollama', 'Ollama (local)', 'http://localhost:11434/v1'),
  local('lmstudio', 'LM Studio (local)', 'http://127.0.0.1:1234/v1'),
  local('llama.cpp', 'llama.cpp server (local)', 'http://127.0.0.1:8080/v1'),
  local('atomic-chat', 'Atomic Chat (local)', 'http://127.0.0.1:1337/v1'),
  { id: 'custom', name: 'Other (any OpenAI-compatible URL)', kind: 'openai', needsKey: false },
];

/** `{NAME}` placeholders in a base URL template. */
export function urlPlaceholders(url: string): string[] {
  return [...url.matchAll(/\{([A-Z0-9_]+)\}/g)].map((match) => match[1]!);
}

/** Fills `{NAME}` placeholders from the environment; undefined while any is missing. */
function resolveTemplate(url: string): string | undefined {
  let resolved = url;
  for (const name of urlPlaceholders(url)) {
    const value = process.env[name];
    if (!value) {
      return undefined;
    }
    resolved = resolved.replace(`{${name}}`, value);
  }
  return resolved;
}

interface StoredProvider {
  apiKey?: string;
  baseURL?: string;
}

interface ProvidersFile {
  providers: Record<string, StoredProvider>;
  active?: { provider: string; model?: string };
  /** Last models picked, newest first (the model picker's "Recent" group). */
  recent?: { provider: string; model: string }[];
}

const MAX_RECENT = 5;

const CONFIG_DIR = join(homedir(), '.aiolah');
const PROVIDERS_FILE = join(CONFIG_DIR, 'providers.json');

function readFile(): ProvidersFile {
  try {
    const data = JSON.parse(readFileSync(PROVIDERS_FILE, 'utf8')) as ProvidersFile;
    return { providers: data.providers ?? {}, active: data.active, recent: data.recent };
  } catch {
    return { providers: {} };
  }
}

function writeFile(data: ProvidersFile): void {
  mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(PROVIDERS_FILE, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 });
  chmodSync(PROVIDERS_FILE, 0o600);
}

/** Headers that carry a provider's API key. */
export function authHeaders(def: ProviderDef, apiKey: string): Record<string, string> {
  return def.authHeader === 'api-key' ? { 'api-key': apiKey } : { Authorization: `Bearer ${apiKey}` };
}

export function providerDef(id: string): ProviderDef {
  const def = PROVIDERS.find((provider) => provider.id === id);
  if (!def) {
    throw new Error(`Unknown provider "${id}". Known: ${PROVIDERS.map((provider) => provider.id).join(', ')}.`);
  }
  return def;
}

/** Credentials for a provider: stored key/URL first, then its environment variable. */
export function providerCredentials(id: string): { apiKey?: string; baseURL?: string } {
  const def = providerDef(id);
  const stored = readFile().providers[id] ?? {};
  const fromEnv = def.envKeys?.map((name) => process.env[name]).find((value) => value);
  return {
    apiKey: stored.apiKey || fromEnv || undefined,
    baseURL: (stored.baseURL || (def.baseURL ? resolveTemplate(def.baseURL) : undefined))?.replace(/\/+$/, ''),
  };
}

export function isConnected(id: string): boolean {
  const def = providerDef(id);
  if (def.kind === 'aiolah') {
    return readAuth() !== null;
  }
  // Keyless providers (Ollama, a custom URL) count once they were connected.
  return def.needsKey ? Boolean(providerCredentials(id).apiKey) : Boolean(readFile().providers[id]);
}

export function saveProvider(id: string, stored: StoredProvider): void {
  const data = readFile();
  data.providers[id] = { ...data.providers[id], ...stored };
  writeFile(data);
}

export function removeProvider(id: string): void {
  const data = readFile();
  delete data.providers[id];
  if (data.active?.provider === id) {
    delete data.active;
  }
  writeFile(data);
}

export function activeSelection(): { provider: string; model?: string } | undefined {
  return readFile().active;
}

export function setActiveSelection(provider: string, model?: string): void {
  const data = readFile();
  data.active = { provider, ...(model ? { model } : {}) };
  if (model) {
    data.recent = [
      { provider, model },
      ...(data.recent ?? []).filter((item) => item.provider !== provider || item.model !== model),
    ].slice(0, MAX_RECENT);
  }
  writeFile(data);
}

/** Recently picked provider/model pairs, newest first. */
export function recentSelections(): { provider: string; model: string }[] {
  return readFile().recent ?? [];
}

/** `--provider`, else the saved choice, else Anthropic when ANTHROPIC_API_KEY is set, else aiolah. */
export function resolveProvider(explicit?: string): string {
  if (explicit) {
    providerDef(explicit);
    return explicit;
  }
  const active = activeSelection();
  if (active) {
    return active.provider;
  }
  return process.env.ANTHROPIC_API_KEY ? 'anthropic' : 'aiolah';
}

/** `--model`, else the saved model for that provider, else the provider's default. */
export async function resolveProviderModel(provider: string, explicit?: string): Promise<string> {
  if (explicit) {
    return explicit;
  }
  const active = activeSelection();
  if (active?.provider === provider && active.model) {
    return active.model;
  }
  const def = providerDef(provider);
  if (def.kind === 'aiolah') {
    const { default: fallback } = await fetchModels();
    if (!fallback) {
      throw new Error('No coding model is available for your aiolah plan right now.');
    }
    return fallback;
  }
  if (def.defaultModel) {
    return def.defaultModel;
  }
  throw new Error(
    `Choose a model for ${def.name}: run \`aiolah models --provider ${provider}\`, then pass --model <id> (or use /models in chat).`,
  );
}

/** Provider + model for a command, from its flags and the saved choice. */
export async function resolveSelection(options: {
  provider?: string;
  model?: string;
}): Promise<{ provider: string; model: string }> {
  const provider = resolveProvider(options.provider);
  return { provider, model: await resolveProviderModel(provider, options.model) };
}

/** Model ids offered by a provider (live from its API). */
export async function listProviderModels(provider: string): Promise<string[]> {
  const def = providerDef(provider);
  if (def.kind === 'aiolah') {
    return (await fetchModels()).data.map((model) => model.id);
  }

  const { apiKey, baseURL } = providerCredentials(provider);
  if (!baseURL) {
    throw new Error(`${def.name} has no base URL. Run \`aiolah connect ${provider}\`.`);
  }
  const headers: Record<string, string> =
    def.kind === 'anthropic'
      ? { 'x-api-key': apiKey ?? '', 'anthropic-version': '2023-06-01' }
      : apiKey
        ? authHeaders(def, apiKey)
        : {};
  const url = def.kind === 'anthropic' ? `${baseURL}/v1/models?limit=100` : `${baseURL}/models`;
  const response = await fetch(url, { headers: { Accept: 'application/json', ...headers } });
  if (response.status === 401 || response.status === 403) {
    throw new Error(`${def.name} rejected the API key (HTTP ${response.status}).`);
  }
  if (!response.ok) {
    throw new Error(`Could not list ${def.name} models (HTTP ${response.status}).`);
  }
  const data = (await response.json()) as { data?: { id: string }[]; models?: { name?: string; id?: string }[] };
  const ids = (data.data ?? []).map((model) => model.id);
  return ids.sort();
}
