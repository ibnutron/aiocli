import { stdout } from 'node:process';
import { costLabel, fetchModels } from '../models.js';
import { activeSelection, listProviderModels, providerDef, resolveProvider } from '../providers.js';

/** `aiolah models [--provider id]` — the aiolah plan's coding models, or a connected provider's. */
export async function modelsCommand(options: { provider?: string }): Promise<void> {
  const provider = resolveProvider(options.provider);
  const active = activeSelection();

  if (providerDef(provider).kind !== 'aiolah') {
    const models = await listProviderModels(provider);
    const current = active?.provider === provider ? active.model : undefined;
    stdout.write(models.map((id) => `${id}${id === current ? '  (active)' : ''}`).join('\n') + '\n');
    stdout.write(
      `\n${models.length} models on ${providerDef(provider).name}. Use one with --provider ${provider} --model <id>.\n`,
    );
    return;
  }

  const { default: fallback, data } = await fetchModels();
  if (data.length === 0) {
    stdout.write('No coding models are available for your aiolah plan right now.\n');
    return;
  }
  const width = Math.max(...data.map((model) => model.id.length));
  const costWidth = Math.max(0, ...data.map((model) => (costLabel(model.cost) ?? '').length));
  for (const model of data) {
    const cost = (costLabel(model.cost) ?? '').padEnd(costWidth);
    stdout.write(`${model.id.padEnd(width)}  ${cost ? `${cost}  ` : ''}${model.name}${model.id === fallback ? '  (default)' : ''}\n`);
  }
  stdout.write(
    '\n$ cheap · $$ mid · $$$ expensive — credits per typical message (1 credit = $0.01 of provider cost).\n' +
      'Use one with --model <id>. Other providers: aiolah connect, then aiolah models --provider <id>.\n',
  );
}
