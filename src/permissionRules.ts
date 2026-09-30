import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * `/permissions` rules for one project (like Claude Code's allow/deny rules),
 * kept in ~/.aiolah/permissions.json so a repo can't grant itself access.
 *
 * A rule is a tool name, optionally with a pattern for its argument:
 * - `run_bash(npm test*)`: shell commands starting with "npm test";
 * - `edit_file(src/*)`, `write_file(docs/**)`: files by path (* = any text);
 * - `mcp__github__*`: every tool of the MCP server "github".
 * Deny rules win over allow rules; deny also applies in bypassPermissions.
 */
export interface ProjectRules {
  allow: string[];
  deny: string[];
}

interface RulesFile {
  projects?: Record<string, Partial<ProjectRules>>;
}

const RULES_FILE = join(homedir(), '.aiolah', 'permissions.json');

/** Tools whose confirm description carries an argument a pattern can match. */
const DESCRIBED_TOOLS: Record<string, RegExp> = {
  run_bash: /^run_bash: ([\s\S]*)$/,
  write_file: /^write_file: (.*)$/,
  edit_file: /^edit_file: (.*)$/,
};

function readRules(): RulesFile {
  try {
    return JSON.parse(readFileSync(RULES_FILE, 'utf8')) as RulesFile;
  } catch {
    return {};
  }
}

export function projectRules(workspaceRoot: string): ProjectRules {
  const rules = readRules().projects?.[resolve(workspaceRoot)];
  return { allow: rules?.allow ?? [], deny: rules?.deny ?? [] };
}

export function saveProjectRules(workspaceRoot: string, rules: ProjectRules): void {
  const file = readRules();
  const projects = file.projects ?? {};
  if (rules.allow.length || rules.deny.length) {
    projects[resolve(workspaceRoot)] = rules;
  } else {
    delete projects[resolve(workspaceRoot)];
  }
  mkdirSync(join(homedir(), '.aiolah'), { recursive: true, mode: 0o700 });
  writeFileSync(RULES_FILE, `${JSON.stringify({ ...file, projects }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  chmodSync(RULES_FILE, 0o600);
}

/** `tool` or `tool(pattern)`; null for anything else. */
export function parseRule(rule: string): { tool: string; pattern: string | null } | null {
  const match = /^([a-zA-Z0-9_*-]+)(?:\((.*)\))?$/.exec(rule.trim());
  return match ? { tool: match[1]!, pattern: match[2]?.trim() || null } : null;
}

function glob(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*+/g, '.*');
  return new RegExp(`^${escaped}$`, 's');
}

export function ruleMatches(rule: string, description: string, tool: string): boolean {
  const parsed = parseRule(rule);
  if (!parsed || !glob(parsed.tool).test(tool)) {
    return false;
  }
  if (!parsed.pattern) {
    return true;
  }
  const argument = DESCRIBED_TOOLS[tool]?.exec(description)?.[1];
  return argument !== undefined && glob(parsed.pattern).test(argument.trim());
}

/** The first deny or allow rule matching the action (deny first), or null. */
export function matchRules(
  rules: ProjectRules,
  description: string,
  tool: string,
): { effect: 'allow' | 'deny'; rule: string } | null {
  const deny = rules.deny.find((rule) => ruleMatches(rule, description, tool));
  if (deny) {
    return { effect: 'deny', rule: deny };
  }
  const allow = rules.allow.find((rule) => ruleMatches(rule, description, tool));
  return allow ? { effect: 'allow', rule: allow } : null;
}
