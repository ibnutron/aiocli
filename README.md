# aiolah CLI

A terminal AI coding agent from [aiolah](https://aiolah.com). It reads and edits
files and runs commands in your project, and you can drive the same session
from your browser, phone or VS Code.

- **No API key needed.** Sign in with your aiolah account; usage is billed to your plan.
- **Many models.** Every coding model enabled on aiolah that your plan allows — not only Claude.
- **Remote control.** `aiolah rc` makes this folder controllable from [aiolah.com/code](https://aiolah.com/code) without opening ports.
- **You stay in control.** File changes and shell commands ask for Allow/Deny unless you choose otherwise.

Requires Node.js 22 or newer.

## Install

```bash
npm install -g @aiolah/cli
# or
curl -fsSL https://aiolah.com/cli/install.sh | bash
```

Check the installation any time with `aiolah doctor`, and the installed version
with `aiolah --version` (`aiolah upgrade` updates it). Folder trust, MCP servers
and auto mode need 0.1.3 or newer.

## Quick start

```bash
aiolah auth login     # approve the code in your browser
cd my-project
aiolah                # interactive chat in this folder
```

`aiolah auth login` prints a code and opens the approval page; after you click
Approve the terminal signs in by itself. `aiolah auth status` shows who is
signed in and until when, `aiolah auth logout` signs out and revokes this
machine's token.

**Your login expires, as in Claude Code.** It stays valid while you use it —
each use extends it to 30 days — but never longer than 90 days after you
signed in. Three days before it ends, aiolah warns at startup (`Your login
expires in 3 days · run aiolah auth login to renew`); once it has expired,
model requests fail with `Login expired · Please run aiolah auth login`, and
`/status` shows `Expired — log in again`. A remote-control device stops working
at that point too, so renew early on machines you control remotely. (The
aiolah server sets these durations and may change them.)

For CI and scripts, `aiolah setup-token` runs the same approval and prints a
**long-lived token** (one year) instead of saving it. Set it as `AIOLAH_TOKEN`
where you need it; it can only make model requests, not remote control.

When you leave `aiolah chat`, it prints how to come back to the same
conversation: `aiolah --resume <session-id>` (or `aiolah -c` for the latest).

## Usage

### In the terminal

```bash
aiolah                  # interactive chat (same as: aiolah chat)
aiolah -c               # continue the last session
aiolah -r <session-id>  # resume a specific session (see: aiolah sessions list)
```

The agent can only touch files inside the workspace folder (`-w`, default: the
current folder).

**Project instructions.** Every session reads `AGENTS.md`, `AIOLAH.md` and
`CLAUDE.md` from the workspace root (an existing `CLAUDE.md` works as is), plus
your own `~/.aiolah/AGENTS.md` for every project, and follows them. `/init`
has the agent study the project and write `AGENTS.md` (commands, architecture,
conventions); `/memory` lists the files in use, `/memory edit` opens the
project's `AGENTS.md` in your editor (`$VISUAL` / `$EDITOR`) and `/memory user`
your own. Edits apply from the next message.

**Long sessions.** `/compact [instructions]` replaces the conversation with a
summary the model writes (files, decisions, next steps), freeing up context.
When a conversation nears the model's context window (80% of 128k tokens by
default; set `AIOLAH_CONTEXT_WINDOW`), the next message compacts it first, and
a request the model rejects as too long is compacted and retried once.
`/status` shows the current size.

**Custom commands and skills** (Claude Code's format, so existing ones work):
a Markdown file in `.aiolah/commands/` or `.claude/commands/` (or
`~/.aiolah/commands/` for every project) becomes `/<name>`, with `$ARGUMENTS`
or `$1`…`$9` for what you type after it and optional frontmatter
`description` / `argument-hint`; subfolders give `/folder:name`. A skill is
`skills/<name>/SKILL.md` with `name` and `description` in its frontmatter: run
it with `/<name>`, and the agent also loads it by itself (`use_skill`) when a
task matches the description. Built in: `/review`, `/security-review` and
`/simplify`.

**Subagents.** The agent can hand a self-contained task to a subagent with its
`task` tool; the subagent works in its own context and only its report comes
back. Built in: `general-purpose` (every tool) and `explore` (read-only
search). Add your own as `.aiolah/agents/<name>.md` (or `.claude/agents/`,
`~/.aiolah/agents/`) with `name`, `description` and optional `tools`
(`Read, Grep, Bash`… as in Claude Code) in the frontmatter and the agent's
instructions as the body; `/agents` lists them and `/agents new <name>`
creates one. Subagents follow the same permission mode and rules.

**Hooks** run your commands on events, in Claude Code's `settings.json` format
(`~/.aiolah/settings.json`, and `.aiolah/` or `.claude/` `settings.json` /
`settings.local.json` in the project):

```json
{ "hooks": {
  "PostToolUse": [{ "matcher": "Edit|Write", "hooks": [{ "type": "command", "command": "npm run lint" }] }],
  "PreToolUse":  [{ "matcher": "Bash", "hooks": [{ "type": "command", "command": "./scripts/check-command.sh" }] }]
} }
```

Events: `PreToolUse`, `PostToolUse`, `UserPromptSubmit`, `Stop` and
`SessionStart`. The command gets the event as JSON on stdin (`tool_name`,
`tool_input`, `tool_response`, `prompt`, …). Exit code 2 blocks: a tool call is
refused (PreToolUse), the result gets the hook's message (PostToolUse), the
prompt is refused (UserPromptSubmit) or the agent keeps working with it
(Stop); the stdout of UserPromptSubmit and SessionStart hooks is added as
context. Matchers are regular expressions over aiolah's tool names and Claude
Code's (`Bash`, `Edit`, `Write`, `Read`). Project hooks run commands from the
repo, so only use them in folders you trust. `/hooks` lists them.

**Look and feel.** `/theme` switches between `dark`, `light` and `mono`
colors; `/vim` turns on vim editing in the input box (Esc for normal mode,
`h l w b e 0 $ x dd D C i a A I`, `j`/`k` for history, Enter sends);
`/statusline <command>` shows the first line of a command's output under the
box — it gets the session as JSON on stdin (model, workspace, permission mode,
context size), as Claude Code's status line does; `/keybindings` lists the
shortcuts. These are saved in `~/.aiolah/settings.json`.

**In your editor (ACP).** `aiolah acp` speaks the
[Agent Client Protocol](https://agentclientprotocol.com) over stdio, so editors
such as Zed can use aiolah as their agent — with your login or provider, your
instruction files, MCP servers (plus the editor's), permission modes (chosen in
the editor) and Allow/Deny questions in the editor. For Zed, add to
`~/.config/zed/settings.json`:

```json
{ "agent_servers": { "aiolah": { "type": "custom", "command": "aiolah", "args": ["acp"], "env": {} } } }
```

**Running on its own.** `/loop [interval] [prompt]` repeats a prompt while the
chat is open (`/loop 5m check if the deploy finished`; the interval is `30s`,
`5m`, `1h`, 10 minutes when left out; without a prompt it runs `.aiolah/loop.md`
or a built-in "continue the unfinished work" prompt; `/loop stop` ends it).
`/background <prompt>` runs a prompt in a copy of the conversation while you keep
chatting; actions that would need your approval are refused there, as in
`aiolah -p`. `/tasks` lists them, `/tasks <id>` shows a result and
`/tasks stop <id>` stops one.

**Shortcuts.** `/keybindings edit` opens `~/.aiolah/keybindings.json` (Claude
Code's format — aiolah also reads `~/.claude/keybindings.json` when it has none
of its own):

```json
{ "bindings": [{ "context": "Chat", "bindings": { "ctrl+g": "chat:externalEditor", "ctrl+x ctrl+k": "chat:modelPicker", "ctrl+s": null } }] }
```

Contexts `Global`, `Chat`, `Autocomplete` and `Confirmation`; actions such as
`chat:submit`, `chat:newline`, `chat:cancel`, `chat:cycleMode`,
`chat:externalEditor`, `chat:modelPicker`, `history:previous`,
`autocomplete:accept` and `confirm:yes` (`/keybindings` lists them all); `null`
unbinds a key; chords are typed within 3 seconds; Ctrl+C and Ctrl+D can't be
rebound. Changes apply without a restart.

**Logs.** Every command writes a log to `~/.aiolah/logs/aiolah.log` (model
requests with timings, tool calls, hooks, MCP and relay events).
`--print-logs` also prints it to stderr and `--log-level DEBUG|INFO|WARN|ERROR`
changes how much is written (also `AIOLAH_LOG_LEVEL`).

**Checkpoints.** Every prompt is a checkpoint. `/rewind` goes back to one:
undo the file changes made since then (by `write_file` / `edit_file`, not by
shell commands), the conversation, or both. `/fork` continues in a copy of the
conversation, `/btw <question>` asks something on the side without adding it
to the conversation, and `/add-dir <path>` (or `--add-dir`) lets the agent use
another directory too.

**Conversations.** `/clear` (also `/new`) starts a new, empty conversation;
the previous one stays saved. `/resume` picks a saved conversation (this
folder's first) and shows it again; `/resume <id>` or `aiolah -r <id>` opens
one directly.

### In scripts and CI

One prompt in, the final answer out. Piped input is appended to the prompt.

```bash
aiolah -p "summarize what this project does"
cat error.log | aiolah -p "explain this error"
aiolah -p "list the TODOs" --output-format json   # {"session_id", "model", "result"}
```

`aiolah -p` is the same as `aiolah run`. Nobody can answer an Allow/Deny prompt
here, so anything the permission mode doesn't allow is denied.

### Remote control

```bash
aiolah rc "My laptop"   # same as: aiolah remote-control "My laptop"
```

The machine appears as a device on [aiolah.com/code](https://aiolah.com/code)
(and in the aiolah app and VS Code extension). It connects out to aiolah — no
open ports, certificates or tokens. Actions that change files or run commands
show an Allow/Deny prompt there.

Already chatting? Type **`/remote-control`** (or `/rc`, with an optional device
name) inside `aiolah chat` to share that conversation instead of starting a new
one — as in Claude Code. The footer shows **/rc active**; prompts sent from
/code run in the terminal chat (marked "from /code"), what you type in the
terminal shows up on /code, and an Allow/Deny question can be answered in
either place (the first answer wins). Run `/remote-control` again to
disconnect. It shares only this chat; use `aiolah rc` when /code should be
able to start new sessions on the device. Needs 0.1.4 or newer.

The Code page also lists your **sessions** — from `aiolah chat`, `aiolah -p`
and `aiolah rc` — with their status (Working, Needs input, Ready for review,
Completed), and you can filter, rename and archive them. **New session**
starts another conversation on an online device; one `aiolah rc` can run
several sessions at once. Sessions stay readable when the device is offline.

From the Code page (and the app / VS Code) you can also attach images to a
prompt, switch the session's model to any the device's provider offers, speak
a prompt, and stop a running turn — including a shell command in progress.

## Models

```bash
aiolah models           # coding models your plan can use, default marked
aiolah --model <id>     # use one
```

The list is read live from aiolah, so models enabled later (or a plan upgrade)
show up without updating the CLI. Without `--model`, your plan's default model
is used.

## Providers & your own keys

Besides your aiolah plan, the CLI can use your own API key from another
provider. Tool calls (reading, editing files, running commands) work the same.

```bash
aiolah connect                  # pick a provider, paste the key
aiolah connect openrouter       # or name it
aiolah models --provider openrouter
aiolah -P openrouter -m <model-id>
aiolah disconnect openrouter
```

| Provider | id | Key |
|---|---|---|
| aiolah (your plan) | `aiolah` | `aiolah auth login` |
| Anthropic | `anthropic` | `ANTHROPIC_API_KEY` |
| OpenAI | `openai` | `OPENAI_API_KEY` |
| Google Gemini | `google` | `GEMINI_API_KEY` / `GOOGLE_API_KEY` / `GOOGLE_GENERATIVE_AI_API_KEY` |
| OpenRouter | `openrouter` | `OPENROUTER_API_KEY` |
| OpenCode Zen | `opencode` | `OPENCODE_API_KEY` |
| xAI | `xai` | `XAI_API_KEY` |
| DeepSeek | `deepseek` | `DEEPSEEK_API_KEY` |
| 302.AI | `302ai` | `302AI_API_KEY` |
| Azure OpenAI | `azure` | `AZURE_API_KEY` / `AZURE_OPENAI_API_KEY` (+ `AZURE_RESOURCE_NAME`) |
| Amazon Bedrock (API key) | `bedrock` | `AWS_BEARER_TOKEN_BEDROCK` |
| Baseten | `baseten` | `BASETEN_API_KEY` |
| Cerebras | `cerebras` | `CEREBRAS_API_KEY` |
| Cloudflare Workers AI | `cloudflare-workers-ai` | `CLOUDFLARE_API_KEY` / `CLOUDFLARE_API_TOKEN` (+ `CLOUDFLARE_ACCOUNT_ID`) |
| Cortecs | `cortecs` | `CORTECS_API_KEY` |
| Deep Infra | `deepinfra` | `DEEPINFRA_API_KEY` |
| DigitalOcean | `digitalocean` | `DIGITALOCEAN_ACCESS_TOKEN` |
| Eden AI | `edenai` | `EDENAI_API_KEY` |
| Fireworks AI | `fireworks` | `FIREWORKS_API_KEY` |
| FrogBot | `frogbot` | `FROGBOT_API_KEY` |
| GMI Cloud | `gmicloud` | `GMICLOUD_API_KEY` |
| Groq | `groq` | `GROQ_API_KEY` |
| Helicone | `helicone` | `HELICONE_API_KEY` |
| Hugging Face | `huggingface` | `HF_TOKEN` |
| IO.NET | `ionet` | `IOINTELLIGENCE_API_KEY` |
| LLM Gateway | `llmgateway` | `LLMGATEWAY_API_KEY` |
| MiniMax | `minimax` | `MINIMAX_API_KEY` |
| Mistral | `mistral` | `MISTRAL_API_KEY` |
| Modal | `modal` | `MODAL_PROXY_TOKEN` |
| Moonshot AI (Kimi) | `moonshot` | `MOONSHOT_API_KEY` |
| Nebius Token Factory | `nebius` | `NEBIUS_API_KEY` |
| NVIDIA | `nvidia` | `NVIDIA_API_KEY` |
| Ollama Cloud | `ollama-cloud` | `OLLAMA_API_KEY` |
| OVHcloud AI Endpoints | `ovhcloud` | `OVHCLOUD_API_KEY` |
| Poolside | `poolside` | `POOLSIDE_API_KEY` |
| Scaleway | `scaleway` | `SCALEWAY_API_KEY` |
| Snowflake Cortex | `snowflake-cortex` | `SNOWFLAKE_CORTEX_PAT` / `SNOWFLAKE_CORTEX_TOKEN` (+ `SNOWFLAKE_ACCOUNT`) |
| STACKIT | `stackit` | `STACKIT_API_KEY` |
| Together AI | `together` | `TOGETHER_API_KEY` |
| Venice AI | `venice` | `VENICE_API_KEY` |
| Vercel AI Gateway | `vercel` | `AI_GATEWAY_API_KEY` |
| Z.AI | `zai` | `ZHIPU_API_KEY` / `ZAI_API_KEY` |
| Z.AI Coding Plan | `zai-coding-plan` | `ZHIPU_API_KEY` / `ZAI_API_KEY` |
| ZenMux | `zenmux` | `ZENMUX_API_KEY` |
| Alibaba Cloud Model Studio (Qwen) | `dashscope` | `DASHSCOPE_API_KEY` |
| Agnes AI | `agnes` | `AGNES_API_KEY` |
| Featherless | `featherless` | `FEATHERLESS_API_KEY` |
| Ollama (local) | `ollama` | no key, `http://localhost:11434/v1` |
| LM Studio (local) | `lmstudio` | no key, `http://127.0.0.1:1234/v1` |
| llama.cpp server (local) | `llama.cpp` | no key, `http://127.0.0.1:8080/v1` |
| Atomic Chat (local) | `atomic-chat` | no key, `http://127.0.0.1:1337/v1` |
| Other (any OpenAI-compatible URL) | `custom` | base URL + optional key |

Local servers and the region/account-specific ones (Amazon Bedrock, Azure,
Cloudflare, Snowflake, NVIDIA on-prem, Alibaba) ask for their URL or account
name on connect. Not supported: sign-in with a Claude, ChatGPT or SuperGrok
subscription (use an API key), and providers that need cloud credentials or
OAuth (Google Vertex AI, Bedrock IAM keys, GitHub Copilot, GitLab Duo,
SAP AI Core, Cloudflare AI Gateway). OpenCode Zen's free models only work
inside OpenCode; its paid models work here.

Keys are saved in `~/.aiolah/providers.json` (readable only by you) and never
sent to aiolah; calls go straight from your machine to the provider, billed to
your own account. The last provider and model you pick in chat are remembered.
Without a choice, `ANTHROPIC_API_KEY` (when set) selects Anthropic, otherwise
your aiolah plan is used.

Inside `aiolah chat`, type `/` commands:

| Command | Description |
|---|---|
| `/clear` | Start a new conversation; the current one stays saved. Aliases: `/new`, `/reset`. |
| `/resume [session]` | Continue a saved conversation (picker without an id). |
| `/compact [instructions]` | Summarize the conversation to free up context. |
| `/init` | Have the agent write `AGENTS.md` for this project. |
| `/memory [edit\|user]` | List the instruction files in use, or edit the project's / your own. |
| `/plan [task\|off]` | Plan mode: read-only until you approve a plan. |
| `/permissions [allow\|deny\|remove <rule>]` | Show or change this folder's allow/deny rules. |
| `/rename <title>` | Name the conversation (shown on /code and in `/resume`). |
| `/btw <question>` | Ask a side question without adding it to the conversation. |
| `/fork` | Continue in a copy of the conversation; the original stays in `/resume`. |
| `/rewind` | Go back to an earlier prompt: undo file changes and/or the conversation. |
| `/add-dir <path>` | Let the agent use another directory too (also `--add-dir`). |
| `/review`, `/security-review`, `/simplify` | Built-in prompts for the pending changes. |
| `/<your-command>` | Custom commands and skills from `.aiolah/commands`, `.aiolah/skills` (and `.claude/…`). |
| `/agents [new <name>]` | List the subagents, or create one. |
| `/theme [dark\|light\|mono]` | Colors of the chat. |
| `/vim` | Toggle vim editing in the input box. |
| `/statusline [command\|off]` | A command whose output is shown under the input box. |
| `/keybindings [edit]` | Keyboard shortcuts; `edit` opens keybindings.json. |
| `/loop [interval] [prompt\|stop]` | Repeat a prompt while the chat is open. Alias: `/proactive`. |
| `/background <prompt>` | Run a prompt in a copy of the conversation in the background. Alias: `/bg`. |
| `/tasks [id\|stop <id>]` | Background tasks: status and results. |
| `/hooks` | List the hooks from settings.json. |
| `/release-notes` | What changed in each version. |
| `/diff [full]` | What changed in the workspace (git status and diff). |
| `/copy [N]` | Copy the assistant's last (or Nth-last) answer to the clipboard. |
| `/export [file]` | Save the conversation as Markdown in the workspace. |
| `/cost` | Model requests and tokens used in this chat. |
| `/usage` | Your aiolah plan and the chat quota left. |
| `/connect [provider]` | Connect aiolah or a provider key. |
| `/disconnect <provider>` | Remove a provider key (or sign out of aiolah). |
| `/provider [id]` | Switch provider, keeping the conversation. |
| `/model [id]` | Switch model; without an id, pick from the provider's list. |
| `/models` | List the current provider's models. |
| `/sessions` | List saved sessions. |
| `/status` | Show provider, model, session, context size and login. |
| `/mcp` | Show MCP servers, their tools and why one failed to start. |
| `/remote-control [name]` | Share this chat with aiolah /code, the app or VS Code; again to disconnect. Alias: `/rc`. |
| `/help`, `/exit` | Help, quit. |

## Permissions

Choose how much the agent may do without asking with `--permission-mode`
(chat, run, rc and serve):

| Mode | Behaviour |
|---|---|
| `default` | Asks before every file change (`write_file`, `edit_file`), shell command (`run_bash`) and MCP tool call. |
| `acceptEdits` | File changes are allowed; shell commands and MCP tools still ask. |
| `plan` | Read-only: the agent looks around and proposes a plan; file changes and commands that change anything are refused. `/plan [task]` turns it on, `/plan off` or Shift+Tab leaves it. |
| `auto` | File changes and read-only commands run; other shell commands and MCP tools are checked by the model first and only asked about when they look risky (see below). |
| `bypassPermissions` | Never asks. Same as `--dangerously-skip-permissions` — only for sandboxes or throwaway machines. |

In chat, **Shift+Tab** cycles through the modes.

**Rules per project.** `/permissions` keeps allow and deny rules for the current
folder in `~/.aiolah/permissions.json` (not in the repo, so a project can't
grant itself access): `/permissions allow "run_bash(npm test*)"`,
`/permissions deny "run_bash(rm *)"`, `/permissions remove <rule>`. A rule is a
tool — `run_bash`, `edit_file`, `write_file` or `mcp__<server>__<tool>` (`*`
matches anything) — optionally with a pattern for the command or path. Allow
rules skip the question; deny rules refuse the action in every mode, including
`bypassPermissions`, and the model is told why.

### Auto mode

`--permission-mode auto` (or Shift+Tab until the box says **Auto**) lets the
agent work without stopping for every command, while still asking about the
ones that matter:

- **Runs without asking:** file changes inside the workspace, and read-only
  commands such as `ls`, `cat`, `grep`, `git status`, `git diff` or `git log`.
- **Always asks:** commands that are dangerous whatever the context — `sudo`,
  deleting top-level folders, piping a download into a shell, force-pushing,
  `git reset --hard`, publishing packages, wiping a database, connecting to
  other machines, and similar.
- **Everything else** (other shell commands and MCP tool calls) is first shown
  to the session's model together with your latest request. Ordinary steps run
  (builds, tests, installs, local commits); the rest comes back to you with the
  reason — anything that pushes, deploys, uploads or touches secrets, and
  anything that does not follow from what you asked (a sign of prompt injection
  from file contents or tool output).

When auto mode asks, the prompt shows why (`$ git push origin main — auto mode:
pushes code to a remote repository`). If the check fails or times out it asks
too; it never allows by default. In `aiolah -p` nobody can answer, so whatever
auto mode would ask about is denied. With your aiolah login these checks are
free: they do not use your plan's quota and are not logged as prompts (up to 30
a minute). With your own provider key they are small extra requests to that
provider.

### Trusting a folder

The first time you run `aiolah` (chat, `rc` or `serve`) in a folder, it asks
**Do you trust the files in this folder?** before anything can read, edit or
run there. **Yes** remembers the folder, and every folder inside it, in
`~/.aiolah/trusted.json`; **No** (or Esc) exits without opening it, and `rc`
does not register the device. Your home folder and filesystem roots are never
remembered, so you are asked there every time. Without a terminal (`aiolah -p`,
`aiolah run`, piped input, CI) nothing is asked. To forget a folder, remove it
from `~/.aiolah/trusted.json`.

## MCP servers

aiolah can use tools from [MCP](https://modelcontextprotocol.io) servers, in
the same format as Claude Code, so an existing `.mcp.json` works unchanged.
Their tools reach the model as `mcp__<server>__<tool>`, and **every call asks
for Allow/Deny** — in auto mode only the calls the reviewer finds risky, and
never with `--dangerously-skip-permissions` (`acceptEdits` only covers file
edits).

```bash
aiolah mcp add boost -- php artisan boost:mcp                 # stdio (put -- before the command)
aiolah mcp add -e GITHUB_TOKEN=… github -- npx -y @modelcontextprotocol/server-github
aiolah mcp add -t http -H "Authorization: Bearer …" docs https://example.com/mcp
aiolah mcp list                                               # status and tool count of each server
aiolah mcp remove boost
```

| Scope (`-s`) | Stored in | Who uses it |
|---|---|---|
| `local` (default) | `~/.aiolah/mcp.json`, under this folder | only you, only in this folder |
| `project` | `.mcp.json` in the folder (commit it) | everyone working in the repo |
| `user` | `~/.aiolah/mcp.json` | you, in every folder |

A name defined in several scopes resolves local → project → user.
`${VAR}` and `${VAR:-default}` in commands, arguments, `env`, URLs and headers
are filled from your environment, so a shared `.mcp.json` never has to contain
tokens.

Servers in a project's `.mcp.json` come from the repo, not from you. The first
time aiolah (chat, `rc`, `serve`) starts in that folder it asks **New MCP server
found in this project** for each one: use it, use it and every future server of
this project, or continue without it (Esc decides next time). Without a
terminal (`aiolah -p`, CI) only servers you already approved start.
`aiolah mcp reset-project-choices` forgets the answers for a folder. In chat,
`/mcp` shows which servers are connected and why one failed. Servers run in the
workspace folder; their log output is kept out of the chat and shown when they
fail to start. Remote servers that use OAuth show `needs sign-in`: `aiolah mcp auth <name>`
opens the login in your browser (a local callback on port 19876 receives it;
`AIOLAH_MCP_OAUTH_PORT` changes it) and keeps the tokens in
`~/.aiolah/mcp-oauth.json`; they are refreshed automatically, and
`aiolah mcp logout <name>` forgets them. Servers that take a token in a header
work with `-H` as well.

## Command reference

Every command accepts `-h, --help`.

| Command | Description |
|---|---|
| `aiolah auth login` | Sign in through your browser (`--server <url>`, `--no-browser`). Shortcut: `aiolah login`. |
| `aiolah auth status` | Show the signed-in account and which credentials model calls use. Alias: `auth list`. |
| `aiolah auth logout` | Sign out and revoke this machine's token. Shortcut: `aiolah logout`. |
| `aiolah setup-token` | Print a one-year token for CI and scripts (use it as `AIOLAH_TOKEN`; model requests only). |
| `aiolah models` | List the coding models your plan can use (`--provider <id>` for a connected provider). |
| `aiolah connect [provider]` | Save your own API key for a provider (see Providers). |
| `aiolah disconnect <provider>` | Remove a saved provider key. |
| `aiolah [chat]` | Interactive agent in the terminal. |
| `aiolah run [prompt...]` / `aiolah -p "<prompt>"` | Non-interactive: answer one prompt and exit (`--output-format text\|json`). |
| `aiolah remote-control [name]` / `aiolah rc [name]` | Control this folder from aiolah (`-n, --name <name>`). |
| `aiolah serve` | Same as `rc` when signed in; with `--port` it runs in direct mode (see below). |
| `aiolah acp` | Run as an Agent Client Protocol agent over stdio (Zed and other editors). |
| `aiolah attach <address>` | Join a direct-mode `serve` session from another machine. |
| `aiolah sessions list` | List saved sessions. |
| `aiolah mcp list` | List MCP servers for this folder and check that they start. |
| `aiolah mcp add <name> -- <command> [args…]` | Add a stdio MCP server (`-s local\|project\|user`, `-e KEY=value`); `-t http\|sse <name> <url>` with `-H "Name: value"` for a remote one. |
| `aiolah mcp auth <name>` / `aiolah mcp logout <name>` | Sign in to (or out of) a remote MCP server that uses OAuth. |
| `aiolah mcp remove <name>` | Remove an MCP server (`-s <scope>` for one scope only). |
| `aiolah mcp reset-project-choices` | Ask again about this folder's `.mcp.json` servers. |
| `aiolah --version` | Print the installed version. Alias: `-v`. |
| `aiolah doctor` | Check installation, login, server, models and relay. Exits 1 on failure. |
| `aiolah upgrade [version]` | Update from npm (`--check` only reports). Alias: `update`. |
| `aiolah uninstall` | Sign out, delete `~/.aiolah` and remove the npm package (`--keep-config`, `--keep-data`, `--dry-run`, `-f`). |

Session flags (chat, run, rc, serve):

| Flag | Description |
|---|---|
| `-m, --model <id>` | Model to use (see `aiolah models`). |
| `-P, --provider <id>` | Provider to use: `aiolah` or one you connected. |
| `-w, --workspace <dir>` | Folder the agent may read and change (default: current folder). |
| `-c, --continue` | Continue the most recently used session. |
| `-r, --resume <id>` | Resume a saved session by id. |
| `--permission-mode <mode>` | `default`, `acceptEdits`, `plan`, `auto` or `bypassPermissions`. |
| `--dangerously-skip-permissions` | Never ask. Only use it in a sandbox. |

## Environment variables

| Variable | Description |
|---|---|
| `ANTHROPIC_API_KEY` | Call Anthropic directly with your own key instead of your aiolah plan (default model `claude-sonnet-5`). |
| Provider keys (`OPENAI_API_KEY`, `OPENROUTER_API_KEY`, `OPENCODE_API_KEY`, `GEMINI_API_KEY`, `ZHIPU_API_KEY`, … — see the table under Providers) | Used for that provider when no key is saved with `aiolah connect`. |
| `AZURE_RESOURCE_NAME`, `CLOUDFLARE_ACCOUNT_ID`, `SNOWFLAKE_ACCOUNT` | Fill in the provider's URL when you do not type it on connect. |
| `AIOLAH_TOKEN` | A token from `aiolah setup-token`; used instead of the saved login (model requests only). |
| `AIOLAH_SERVER` | aiolah server URL (default `https://aiolah.com`). Overrides the server saved at login. |
| `AIOLAH_RELAY_URL` | Relay URL for remote control (default `<server>/cli-relay`). |
| `AIOLAH_REMOTE_TOKEN` | Shared secret for direct mode (`serve --port` and `attach`). |
| `AIOLAH_CONTEXT_WINDOW` | Context window (tokens) used to decide when to compact automatically (default 128000). |
| `MCP_TIMEOUT` | Milliseconds to wait for an MCP server to start (default 30000). |
| `MCP_TOOL_TIMEOUT` | Milliseconds an MCP tool call may take (default 600000; progress updates reset it). |

Exported variables win over a `.env` file next to the installed package.
Empty values count as unset.

## Privacy & data

- **Prompts sent through aiolah are logged to your account.** When you use the
  CLI with your aiolah login, every new prompt you send — typed in the
  terminal, sent from `/code` / the app / VS Code, or passed to `aiolah -p` — is
  recorded together with the model, device, session id and CLI version. Tool
  results and file contents in follow-up steps are sent to the model but not
  logged as prompts.
- **Sessions are saved to your account.** When signed in, each session's
  prompts, answers, tool calls and tool results (including file contents, up
  to 20 KB per result) are sent to aiolah so they can be read on the Code page
  even when the device is offline.
- **Your own keys bypass the aiolah proxy.** With a provider from
  `aiolah connect` (or `ANTHROPIC_API_KEY`), model calls go straight to that
  provider and are not logged as prompts. Keys stay on your machine. If you are
  also signed in, the session transcript is still saved to your account (see
  above); run `aiolah auth logout` to keep it local only.
- **Local history.** Full sessions (conversation, tool calls, file contents) are
  saved as plain JSON in `~/.aiolah/sessions/` on the machine running the agent.
  Your login token is in `~/.aiolah/auth.json` (mode 0600). Folders you trusted are listed
  in `~/.aiolah/trusted.json`; your MCP servers and your answers about project
  servers are in `~/.aiolah/mcp.json` and `~/.aiolah/mcp-approvals.json`.
- **MCP servers get what the model sends them.** Tool arguments and results
  pass between the model and your MCP servers; results are part of the
  conversation (and of the synced session when signed in).
- **The relay keeps nothing.** Remote-control messages pass through the aiolah
  relay without being stored (the session sync above is a separate HTTPS call).

## Uninstall

```bash
aiolah uninstall --dry-run   # show what would be removed
aiolah uninstall             # sign out, delete ~/.aiolah, npm uninstall -g @aiolah/cli
```

It revokes this machine's login token on aiolah, deletes your login, provider
keys, device id, trusted folders and MCP servers (`--keep-config` keeps them) and saved sessions
(`--keep-data` keeps them), then removes the package. `-f` skips the
confirmation. Devices registered with `aiolah rc` stay on the Code page until
you remove them there. Installed another way? `npm uninstall -g @aiolah/cli`
and `rm -rf ~/.aiolah` do the same by hand.

## Troubleshooting

- `aiolah doctor` checks everything and tells you what to fix.
- `aiolah --version` shows the installed version; `aiolah upgrade` installs the
  latest (`--check` only reports).
- **Unknown command `mcp` or option `--permission-mode auto`** — your CLI is
  older than 0.1.3; run `aiolah upgrade`.
- **"Your plan quota is used up"** — the plan limit was reached; wait for the
  reset or upgrade your plan.
- **429 / "Provider returned error" on a free model** — free models are often
  busy; try again or pick another model from `aiolah models`.
- **"Not logged in"** — run `aiolah auth login`, or set `ANTHROPIC_API_KEY`.
- **"Login expired · Please run aiolah auth login"** — the login was unused for
  30 days or is older than 90 days; sign in again.

## Advanced

### Direct mode (LAN / self-hosted, no aiolah account)

```bash
AIOLAH_REMOTE_TOKEN=<long-random-secret> aiolah serve --port 4317
aiolah attach ws://<host>:4317          # from another machine
```

Clients answer an HMAC challenge with the token (it never crosses the wire).
The page at aiolah.com/code can also connect ("Add direct device"), but an
`https://` page only accepts `wss://` — serve with `--cert <path> --key <path>`
or put a TLS proxy in front. Before exposing direct mode beyond localhost:

1. Always use TLS — prompts, file contents and command output cross the wire.
2. Set a long, fixed `AIOLAH_REMOTE_TOKEN` (32+ random bytes).
3. Don't open the port publicly; use a VPN, an SSH tunnel or a reverse proxy.
4. Keep the default permission mode on machines you care about; an unattended
   host (closed stdin) gets approvals from connected clients, and unanswered
   prompts are denied after 5 minutes.
5. Scope the workspace with `-w` and run as a low-privilege user.

### Running the relay (aiolah operators)

`aiolah relay --port 4320 --api https://aiolah.com` with `CLI_RELAY_SECRET`
set (must match the aiolah app). It binds 127.0.0.1; put it behind a TLS
reverse proxy at `/cli-relay/`. Hosts connect to `/host` with their CLI token
and device id (verified against aiolah); clients connect to
`/client?ticket=…` with a 60-second single-use ticket issued by aiolah and
checked locally. The relay only forwards frames and stores nothing.

### Wire protocol (for building clients)

JSON messages over one WebSocket:

1. Direct mode only: server → `{type:"challenge", nonce}`; client →
   `{type:"auth", hmac}` with `hmac = hex(HMAC-SHA256(key = token, message = nonce))`.
   Wrong answer → `{type:"error", text:"unauthorized"}` and the socket closes.
   Relay clients skip this step (the ticket authenticates them).
2. Server → `{type:"authed", sessionId, sessionUuid, workspace, model, history}`,
   where `history` holds `{role:"user"|"assistant", text}` and
   `{role:"tool", name, input, result}` items, and `sessionUuid` is the aiolah
   session id when the host is signed in (else `null`).
   A host serves several sessions: relay clients pick one with
   `/client?ticket=…&session=<id>|new` (no parameter = the host's main
   session); any client can switch with `{type:"open_session", session}`.
3. Client → `{type:"user", text}` starts a turn. The server sends
   `{type:"busy"}`, then `{type:"tool", name, input}` /
   `{type:"tool_result", name, result}` per tool call, then
   `{type:"assistant", text}` and `{type:"idle"}`. Other connected clients
   receive the same `user` message.
4. When a tool needs approval: `{type:"confirm", id, description}` to every
   client; the first `{type:"confirm_reply", id, allow}` (or `y`/`n` on the host
   terminal) wins. No answer within 5 minutes counts as denied.
5. Since 0.1.2 (`authed` then also carries `provider`):
   - `{type:"user", text, images}` attaches up to 4 images
     (`{media_type, data}` with base64 data, 3.5 MB of base64 in total); other
     clients receive `{type:"user", text, imageCount}`.
   - `{type:"list_models"}` → `{type:"models", provider, current, models}`
     (`models`: `{id, name?}`), the models this session can switch to.
   - `{type:"set_model", model}` (while idle) switches the session's model;
     every client receives `{type:"model", provider, model}`.
   - `{type:"interrupt"}` stops the running turn (model call or shell command);
     clients receive `{type:"interrupted"}` and `{type:"idle"}`.
6. Since 0.1.4 the host streams the answer: `{type:"assistant_delta", text}`
   pieces (every ~50 ms while the model writes, also text before tool calls)
   arrive before the `tool` messages and the final `{type:"assistant", text}`,
   which still carries the complete reply. Clients that ignore
   `assistant_delta` keep working.

## Development

```bash
git clone https://github.com/ibnutron/aiocli && cd aiocli
npm install && npm run build && npm link
npm run typecheck
```

## License

MIT
