import type Anthropic from '@anthropic-ai/sdk';
import { readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseFrontmatter } from './customCommands.js';

/**
 * Subagents in Claude Code's format (`agents/<name>.md` with frontmatter
 * `name`, `description`, optional `tools`; the body is the agent's prompt),
 * from the project's .aiolah/ and .claude/ and the user's ~/.aiolah/ and
 * ~/.claude/. The main agent starts one with the `task` tool; it works in its
 * own context and only its final report comes back.
 */
export interface AgentDefinition {
  name: string;
  description: string;
  /** aiolah tool names the agent may use; null = every tool (except task). */
  tools: string[] | null;
  prompt: string;
  source: 'project' | 'user' | 'built-in';
  path?: string;
}

/** Claude Code tool names in `tools:` frontmatter → aiolah tools. */
const CLAUDE_TOOLS: Record<string, string[]> = {
  read: ['read_file'],
  write: ['write_file'],
  edit: ['edit_file'],
  multiedit: ['edit_file'],
  bash: ['run_bash'],
  ls: ['list_dir'],
  glob: ['list_dir', 'run_bash'],
  grep: ['run_bash'],
};

const BUILT_IN: AgentDefinition[] = [
  {
    name: 'general-purpose',
    description: 'Multi-step tasks and research that would fill the main conversation; can use every tool.',
    tools: null,
    prompt: 'Complete the task fully and report the outcome, with file paths for anything you changed.',
    source: 'built-in',
  },
  {
    name: 'explore',
    description: 'Read-only search of the codebase: find files, code and answers to questions about it.',
    tools: ['read_file', 'list_dir', 'run_bash'],
    prompt:
      'You only look, never change: read files, list folders and use read-only commands (ls, grep, find, git log). ' +
      'Report what you found concisely with file paths and line numbers.',
    source: 'built-in',
  },
];

function agentsIn(base: string, source: AgentDefinition['source']): AgentDefinition[] {
  const dir = join(base, 'agents');
  let entries: string[];
  try {
    entries = readdirSync(dir).filter((entry) => entry.endsWith('.md'));
  } catch {
    return [];
  }
  const found: AgentDefinition[] = [];
  for (const entry of entries) {
    const path = join(dir, entry);
    let text: string;
    try {
      text = readFileSync(path, 'utf8').slice(0, 40_000);
    } catch {
      continue;
    }
    const { meta, body } = parseFrontmatter(text);
    const tools = meta.tools
      ? [
          ...new Set(
            meta.tools
              .split(/[\s,]+/)
              .filter(Boolean)
              .flatMap((tool) => CLAUDE_TOOLS[tool.toLowerCase()] ?? [tool]),
          ),
        ]
      : null;
    found.push({
      name: (meta.name || entry.replace(/\.md$/, '')).toLowerCase(),
      description: meta.description || 'Custom agent',
      tools,
      prompt: body.trim(),
      source,
      path,
    });
  }
  return found;
}

/** Every subagent available in `workspaceRoot`: project first, then the user's, then the built-in ones. */
export function loadAgents(workspaceRoot: string): AgentDefinition[] {
  const root = resolve(workspaceRoot);
  const all = [
    ...['.aiolah', '.claude'].flatMap((dir) => agentsIn(join(root, dir), 'project')),
    ...[join(homedir(), '.aiolah'), join(homedir(), '.claude')].flatMap((dir) => agentsIn(dir, 'user')),
    ...BUILT_IN,
  ];
  const byName = new Map<string, AgentDefinition>();
  for (const agent of all) {
    if (/^[a-z0-9][a-z0-9_-]*$/.test(agent.name) && !byName.has(agent.name)) {
      byName.set(agent.name, agent);
    }
  }
  return [...byName.values()];
}

/** The `task` tool the main agent uses to start a subagent. */
export function taskToolSchema(agents: AgentDefinition[]): Anthropic.Tool {
  return {
    name: 'task',
    description:
      'Start a subagent for a self-contained task (searching the codebase, a multi-step change) so its work does ' +
      'not fill this conversation; only its final report comes back. Give it a complete, specific prompt. ' +
      `Agents: ${agents.map((agent) => `${agent.name} — ${agent.description}`).join('; ')}`,
    input_schema: {
      type: 'object',
      properties: {
        description: { type: 'string', description: 'A short (3-5 word) summary of the task' },
        prompt: { type: 'string', description: 'The full task for the subagent' },
        subagent_type: { type: 'string', enum: agents.map((agent) => agent.name), description: 'Which agent to use' },
      },
      required: ['description', 'prompt', 'subagent_type'],
    },
  };
}

/** Template for `/agents new <name>`. */
export function agentTemplate(name: string): string {
  return [
    '---',
    `name: ${name}`,
    'description: When the main agent should use this agent (one sentence).',
    'tools: Read, Grep, Bash',
    '---',
    '',
    `You are the ${name} agent. Describe how it should work and what its report should contain.`,
    '',
  ].join('\n');
}
