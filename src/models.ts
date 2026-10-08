import { expiredMessage } from './loginStatus.js';
import { apiRequest, readAuth, serverUrl } from './config.js';

export interface CliModel {
  id: string;
  name: string;
  provider: string;
  developer: string | null;
  tier: string;
  featured: boolean;
  /** Cost badge from aiolah (newer servers): credits per message and a cheap/mid/high level. */
  cost?: { credits: number; unit: string; level: 'low' | 'mid' | 'high'; per_second: number | null } | null;
}

/** "$ 0.09 cr/msg" — the same cost signs as the aiolah web and app model pickers. */
export function costLabel(cost: CliModel['cost']): string | undefined {
  if (!cost) return undefined;
  const signs = { low: '$', mid: '$$', high: '$$$' }[cost.level];
  const credits = cost.credits.toLocaleString('en-US', { maximumFractionDigits: cost.credits < 1 ? 2 : 1 });
  return `${signs} ${credits} cr/msg`;
}

/**
 * Coding models the logged-in account's plan may use, read live from aiolah —
 * models activated by an admin (or a plan upgrade) show up without a CLI release.
 */
export interface CliModelList {
  /** The account's plan (sent by aiolah since the plan label was added; older servers omit it). */
  plan?: { name: string };
  default: string | null;
  data: CliModel[];
}

export async function fetchModels(): Promise<CliModelList> {
  const auth = readAuth();
  if (!auth) {
    throw new Error('Not logged in. Run `aiolah auth login` (or set ANTHROPIC_API_KEY to use your own key).');
  }
  const response = await apiRequest<CliModelList>(serverUrl(auth), '/api/cli/models', {
    token: auth.token,
  });
  if (response.status === 401 || response.status === 403) {
    throw new Error(expiredMessage());
  }
  if (response.status !== 200) {
    throw new Error(`Could not load models from aiolah (HTTP ${response.status}).`);
  }
  return response.data;
}
