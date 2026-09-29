import * as readline from 'node:readline/promises';
import type { Interface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { ask, askSecret, pick } from '../prompt.js';
import {
  PROVIDERS,
  isConnected,
  providerCredentials,
  urlPlaceholders,
  listProviderModels,
  providerDef,
  removeProvider,
  saveProvider,
  setActiveSelection,
} from '../providers.js';
import { clearAuth, readAuth } from '../config.js';
import { loginCommand } from './login.js';

const MAX_MODELS_SHOWN = 40;

/**
 * Connect a provider: the aiolah account (device
 * sign-in) or your own key for Anthropic / an OpenAI-compatible API. Checks
 * the key by listing the provider's models, then lets you pick one as the
 * active model. Shared by `aiolah connect` and `/connect` in chat.
 * Returns the chosen provider + model, or null when cancelled.
 */
export async function connectFlow(
  rl: Interface,
  providerId?: string,
): Promise<{ provider: string; model?: string } | null> {
  let id = providerId;
  if (!id) {
    const choice = await pick(
      rl,
      'Connect a provider:',
      PROVIDERS.map((provider) => `${isConnected(provider.id) ? '✓' : ' '} ${provider.name}  [${provider.id}]`),
      PROVIDERS.map((provider) => provider.id),
    );
    if (choice === null) return null;
    id = PROVIDERS[choice]!.id;
  }
  const def = providerDef(id);

  if (def.kind === 'aiolah') {
    if (!readAuth()) {
      await loginCommand({});
    }
  } else {
    if (def.note) stdout.write(`${def.note}\n`);
    const placeholders = def.baseURL ? urlPlaceholders(def.baseURL) : [];
    if (placeholders.length) {
      let url = def.baseURL as string;
      for (const name of placeholders) {
        const current = process.env[name] ?? '';
        const value = (await ask(rl, `${name}${current ? ` [${current}]` : ''}: `))?.trim() || current;
        if (!value) return null;
        url = url.replace(`{${name}}`, value);
      }
      saveProvider(id, { baseURL: url });
    } else if (id === 'custom' || def.askBaseUrl) {
      const current = providerCredentials(id).baseURL ?? def.baseURL ?? '';
      const label = def.kind === 'anthropic' ? 'Base URL (Anthropic-compatible)' : 'Base URL (OpenAI-compatible)';
      const url = (await ask(rl, `${label}${current ? ` [${current}]` : ''}: `))?.trim() || current;
      if (!url) return null;
      saveProvider(id, { baseURL: url });
    }
    if (def.needsKey || id === 'custom') {
      if (def.keyUrl) stdout.write(`Create a key at ${def.keyUrl}\n`);
      const key = (await askSecret(rl, `${def.name} API key${def.needsKey ? '' : ' (Enter if none)'}: `))?.trim();
      if (def.needsKey && !key) return null;
      if (key) saveProvider(id, { apiKey: key });
    }
  }

  let models: string[] = [];
  try {
    models = await listProviderModels(id);
    stdout.write(`✓ Connected to ${def.name} (${models.length} models).\n`);
  } catch (error) {
    stdout.write(`! Saved, but could not list models: ${error instanceof Error ? error.message : String(error)}\n`);
  }

  let model: string | undefined;
  if (models.length > 0) {
    const shown = models.slice(0, MAX_MODELS_SHOWN);
    const choice = await pick(
      rl,
      `Choose a model${
        models.length > shown.length ? ` (first ${shown.length}; any id also works with --model)` : ''
      }:`,
      shown,
    );
    model = choice === null ? undefined : shown[choice];
  } else if (def.kind !== 'aiolah') {
    model = (await ask(rl, 'Model id (Enter to skip): '))?.trim() || undefined;
  }

  setActiveSelection(id, model);
  stdout.write(`Active: ${def.name}${model ? ` · ${model}` : ' (default model)'}\n`);
  return { provider: id, model };
}

export async function connectCommand(providerId?: string): Promise<void> {
  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    await connectFlow(rl, providerId);
  } finally {
    rl.close();
  }
}

export async function disconnectCommand(providerId: string): Promise<void> {
  const def = providerDef(providerId);
  if (def.kind === 'aiolah') {
    clearAuth();
  } else {
    removeProvider(providerId);
  }
  stdout.write(`Disconnected ${def.name}.\n`);
}
