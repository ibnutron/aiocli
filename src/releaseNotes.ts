/** What changed in each version, newest first (shown by /release-notes). */
export const RELEASE_NOTES: { version: string; changes: string[] }[] = [
  {
    version: '0.1.4',
    changes: [
      'Project instructions: AGENTS.md, AIOLAH.md, CLAUDE.md and ~/.aiolah/AGENTS.md; /init and /memory',
      '/clear starts a new conversation; /resume, /fork, /rewind (checkpoints), /compact and automatic compaction',
      'Plan mode (/plan), /permissions allow/deny rules, /add-dir and --add-dir',
      'Custom commands and skills (.aiolah/commands, .aiolah/skills, .claude/…); /review, /security-review, /simplify',
      'Subagents (task tool, /agents, .aiolah/agents) and hooks from settings.json (Claude Code format)',
      'aiolah acp for editors such as Zed; /theme, /vim, /statusline, /keybindings; --print-logs and --log-level',
      '/loop, /background, /tasks; shortcuts in keybindings.json; aiolah mcp auth/logout (OAuth for MCP servers)',
      'Answers appear while they are written (streaming), with any provider and in aiolah acp',
      'The home screen shows the new aiolah mark (as in the favicon)',
      '/remote-control inside chat; /btw, /rename, /diff, /copy, /export, /cost, /usage, /release-notes',
      'Logins expire unless used (as in Claude Code); aiolah setup-token and AIOLAH_TOKEN for CI',
      'Leaving chat prints how to resume; aiolah -r <id> / -c work without "chat"',
    ],
  },
  {
    version: '0.1.3',
    changes: [
      'Asks whether to trust a folder the first time',
      'MCP servers (.mcp.json, aiolah mcp add/list/remove, /mcp) with a dialog for project servers',
      'Auto permission mode: the model reviews risky shell commands and MCP calls',
    ],
  },
  {
    version: '0.1.2',
    changes: [
      'aiolah connect for about 50 providers with your own key, and aiolah uninstall',
      'Remote control from /code: switch models, attach images, stop a running turn',
    ],
  },
  {
    version: '0.1.1',
    changes: [
      'aiolah -p / run for scripts, doctor, upgrade, --permission-mode',
      'Sign in with aiolah auth login and control a folder with aiolah rc',
    ],
  },
];
