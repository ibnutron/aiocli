import * as readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createServer as createHttpsServer } from 'node:https';
import { homedir, hostname } from 'node:os';
import { basename, join, resolve } from 'node:path';
import WebSocket, { WebSocketServer } from 'ws';
import { ChatSession, TurnInterruptedError, type PromptOrigin } from '../session.js';
import { SessionSync } from '../sessionSync.js';
import { generateNonce, verifyChallenge } from '../auth.js';
import { apiRequest, machineIdFor, readAuth, relayHostUrl, serverUrl, type StoredAuth } from '../config.js';
import { findLatestSession } from '../persistence.js';
import { ensureTrusted } from '../trust.js';
import { mcpSummary, startMcp } from '../mcp/index.js';
import { ask } from '../prompt.js';
import { listProviderModels, providerDef, resolveSelection } from '../providers.js';
import { fetchModels } from '../models.js';
import { SESSION_SELECTOR, type ImageInput, type ModelOption, type RelayFrame, type WireMessage } from '../protocol.js';
import { resolvePermissionMode, type PermissionOptions } from '../permissions.js';
import type { ConfirmFn } from '../tools/index.js';

interface ServeOptions extends PermissionOptions {
  port?: string;
  name?: string;
  model?: string;
  provider?: string;
  workspace: string;
  resume?: string;
  continue?: boolean;
  cert?: string;
  key?: string;
}

/** A connected, authenticated client — a direct WebSocket or one relayed through aiolah. */
interface Peer {
  send(message: WireMessage): void;
}

/** One conversation the host serves: its clients, busy flag and open Allow/Deny prompts. */
interface SessionRuntime {
  session: ChatSession;
  sync: SessionSync | null;
  peers: Set<Peer>;
  pendingConfirms: Map<string, (allow: boolean) => void>;
  busy: boolean;
}

const MAX_AUTH_ATTEMPTS = 3;
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_ATTEMPTS = 5;
const CONFIRM_TIMEOUT_MS = 5 * 60_000;
const RELAY_BACKOFF_MAX_MS = 30_000;
const RELAY_SILENCE_TIMEOUT_MS = 75_000;
const MAX_IMAGES = 4;
/** Base64 characters across all images of one prompt; keeps a frame under the relay's 4 MB limit. */
const MAX_IMAGE_CHARS = 3_500_000;
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

/** Attached images if they are acceptable, [] for none, null when they are not. */
function validImages(images: unknown): ImageInput[] | null {
  if (images === undefined || images === null) {
    return [];
  }
  if (!Array.isArray(images) || images.length > MAX_IMAGES) {
    return null;
  }
  let total = 0;
  for (const image of images as Partial<ImageInput>[]) {
    if (!image || !IMAGE_TYPES.has(String(image.media_type)) || typeof image.data !== 'string') {
      return null;
    }
    total += image.data.length;
  }
  return total <= MAX_IMAGE_CHARS ? (images as ImageInput[]) : null;
}

/** Models a client may switch to: the plan's list for aiolah (with names), the provider's live list otherwise. */
async function listModelOptions(provider: string): Promise<ModelOption[]> {
  if (providerDef(provider).kind === 'aiolah') {
    return (await fetchModels()).data.map((model) => ({ id: model.id, name: model.name }));
  }
  return (await listProviderModels(provider)).map((id) => ({ id }));
}

/**
 * Two ways to be reachable:
 * - relay (default after `aiolah auth login`): dial out to the aiolah relay,
 *   no open port, no certificate, no token; the machine shows up on /code
 *   automatically.
 * - direct (`--port`): listen for WebSocket clients that authenticate with
 *   AIOLAH_REMOTE_TOKEN (LAN, self-hosting, or no aiolah account).
 *
 * The host can serve several sessions at once: the main one (also typed into
 * from this terminal) plus any a client opens (`session=new`) or resumes by
 * id. When signed in, every session is reported to aiolah's Sessions list.
 */
export async function serveCommand(options: ServeOptions): Promise<void> {
  const workspaceRoot = resolve(options.workspace);
  const resumeId = options.resume ?? (options.continue ? findLatestSession()?.id : undefined);
  const auth = readAuth();
  const relayMode = options.port === undefined;

  if (relayMode && !auth) {
    throw new Error(
      'Not logged in. Run `aiolah auth login` to control this machine from aiolah, ' +
        'or pass --port to accept direct connections with AIOLAH_REMOTE_TOKEN.',
    );
  }

  // Before the device is registered, so an untrusted folder never shows up on /code.
  if (!(await ensureTrusted(workspaceRoot))) {
    process.exitCode = 1;
    return;
  }
  const mcp = await startMcp(workspaceRoot);
  const mcpProblem = mcpSummary(mcp);
  if (mcpProblem) {
    stdout.write(`${mcpProblem.replace('see /mcp', 'run "aiolah mcp list"')}\n`);
  }

  const selection = await resolveSelection(options);
  const permissionMode = resolvePermissionMode(options);
  const deviceName = options.name?.trim() || `${hostname()} · ${basename(workspaceRoot) || workspaceRoot}`;
  const hostId = relayMode ? await registerHost(auth as StoredAuth, workspaceRoot, deviceName) : undefined;
  const runtimes = new Map<string, SessionRuntime>();

  function createRuntime(sessionToResume?: string): SessionRuntime {
    const pendingConfirms = new Map<string, (allow: boolean) => void>();
    const peers = new Set<Peer>();

    // Confirmation is answered by whoever responds first: a client of this
    // session (`confirm_reply`) or the host operator typing y/n here. Only
    // reached when the permission mode wants a human answer (see ChatSession).
    const confirm: ConfirmFn = (description) =>
      new Promise<boolean>((resolveConfirm) => {
        const id = randomBytes(6).toString('hex');
        const timer = setTimeout(() => settle(false), CONFIRM_TIMEOUT_MS);
        const settle = (allow: boolean) => {
          if (!pendingConfirms.has(id)) {
            return;
          }
          clearTimeout(timer);
          pendingConfirms.delete(id);
          resolveConfirm(allow);
        };
        pendingConfirms.set(id, settle);
        broadcast(runtime, { type: 'confirm', id, description });
        stdout.write(
          `\n[confirm ${session.sessionId}] Allow ${description}? Type y or n here, or answer from a client.\n`,
        );
      });

    const session = new ChatSession({
      ...selection,
      workspaceRoot,
      confirm,
      permissionMode,
      resumeId: sessionToResume,
      mcp,
    });
    session.hostId = hostId;
    const runtime: SessionRuntime = {
      session,
      sync: SessionSync.attach(session, { hostId, origin: 'remote' }),
      peers,
      pendingConfirms,
      busy: false,
    };

    session.on('tool', ({ name, input }) => {
      stdout.write(`\n[tool ${session.sessionId}] ${name} ${JSON.stringify(input)}\n`);
      broadcast(runtime, { type: 'tool', name, input });
    });
    session.on('tool_result', ({ name, result }) => {
      broadcast(runtime, { type: 'tool_result', name, result });
    });

    runtimes.set(session.sessionId, runtime);
    return runtime;
  }

  const main = createRuntime(resumeId);

  /** Resolves a client's session selector: none = main, `new`, a running session, or one saved on disk. */
  function runtimeFor(selector?: string): SessionRuntime | null {
    if (!selector) {
      return main;
    }
    if (selector === 'new') {
      return createRuntime();
    }
    if (!SESSION_SELECTOR.test(selector)) {
      return null;
    }
    const running = runtimes.get(selector);
    if (running) {
      return running;
    }
    return existsSync(join(homedir(), '.aiolah', 'sessions', `${selector}.json`)) ? createRuntime(selector) : null;
  }

  async function addPeer(runtime: SessionRuntime, peer: Peer): Promise<void> {
    runtime.peers.add(peer);
    peer.send({
      type: 'authed',
      sessionId: runtime.session.sessionId,
      sessionUuid: runtime.sync ? await runtime.sync.ready : null,
      workspace: workspaceRoot,
      model: runtime.session.modelId,
      provider: runtime.session.providerId,
      history: runtime.session.renderHistory(),
    });
    if (runtime.busy) {
      peer.send({ type: 'busy' });
    }
    stdout.write(`\n[remote client connected to session ${runtime.session.sessionId}]\n`);
  }

  /** Handles a message from an authenticated client; returns the runtime the client is now attached to. */
  async function handlePeerMessage(runtime: SessionRuntime, peer: Peer, message: WireMessage): Promise<SessionRuntime> {
    if (message.type === 'open_session') {
      const next = runtimeFor(message.session);
      if (!next) {
        peer.send({ type: 'error', text: 'unknown session' });
        return runtime;
      }
      runtime.peers.delete(peer);
      await addPeer(next, peer);
      return next;
    }

    if (message.type === 'confirm_reply') {
      runtime.pendingConfirms.get(message.id)?.(message.allow);
      return runtime;
    }

    if (message.type === 'list_models') {
      const session = runtime.session;
      try {
        peer.send({
          type: 'models',
          provider: session.providerId,
          current: session.modelId,
          models: await listModelOptions(session.providerId),
        });
      } catch (error) {
        peer.send({ type: 'error', text: error instanceof Error ? error.message : String(error) });
      }
      return runtime;
    }

    if (message.type === 'set_model') {
      const model = String(message.model ?? '').trim();
      if (runtime.busy) {
        peer.send({ type: 'error', text: 'busy' });
      } else if (!model || model.length > 200) {
        peer.send({ type: 'error', text: 'invalid model' });
      } else {
        runtime.session.useModel(runtime.session.providerId, model);
        stdout.write(`\n[session ${runtime.session.sessionId}] model → ${model}\n`);
        broadcast(runtime, { type: 'model', provider: runtime.session.providerId, model });
      }
      return runtime;
    }

    if (message.type === 'interrupt') {
      if (runtime.session.interrupt()) {
        for (const settle of [...runtime.pendingConfirms.values()]) {
          settle(false);
        }
      }
      return runtime;
    }

    if (message.type === 'user') {
      if (runtime.busy) {
        peer.send({ type: 'error', text: 'busy' });
        return runtime;
      }
      const images = validImages(message.images);
      if (images === null) {
        peer.send({
          type: 'error',
          text: `Attach at most ${MAX_IMAGES} PNG, JPEG, GIF or WebP images under 3 MB each.`,
        });
        return runtime;
      }
      stdout.write(
        `\nremote [${runtime.session.sessionId}]> ${message.text}${images.length ? ` [${images.length} image(s)]` : ''}\n`,
      );
      broadcast(runtime, { type: 'user', text: message.text, imageCount: images.length || undefined }, peer);
      void runTurn(runtime, message.text, 'remote', images);
    }
    return runtime;
  }

  async function runTurn(
    runtime: SessionRuntime,
    text: string,
    origin: PromptOrigin,
    images: ImageInput[] = [],
  ): Promise<void> {
    runtime.busy = true;
    broadcast(runtime, { type: 'busy' });
    try {
      const { reply } = await runtime.session.send(text, origin, images);
      broadcast(runtime, { type: 'assistant', text: reply });
      if (runtime === main) {
        stdout.write(`\nassistant> ${reply}\n\n`);
      }
    } catch (error) {
      if (error instanceof TurnInterruptedError) {
        broadcast(runtime, { type: 'interrupted' });
        stdout.write(`\n[interrupted ${runtime.session.sessionId}]\n\n`);
        return;
      }
      const text = error instanceof Error ? error.message : String(error);
      broadcast(runtime, { type: 'error', text });
      stdout.write(`\n[error ${runtime.session.sessionId}] ${text}\n\n`);
    } finally {
      runtime.busy = false;
      broadcast(runtime, { type: 'idle' });
    }
  }

  function broadcast(runtime: SessionRuntime, message: WireMessage, except?: Peer): void {
    for (const peer of runtime.peers) {
      if (peer !== except) {
        peer.send(message);
      }
    }
  }

  const hooks: ServeHooks = {
    connect: async (peer, selector) => {
      const runtime = runtimeFor(selector);
      if (!runtime) {
        peer.send({ type: 'error', text: 'unknown session' });
        return null;
      }
      await addPeer(runtime, peer);
      return runtime;
    },
    message: handlePeerMessage,
    disconnect: (runtime, peer) => runtime.peers.delete(peer),
  };

  const banner = relayMode
    ? startRelay(auth as StoredAuth, hostId as number, deviceName, hooks)
    : startDirect(options, hooks);

  stdout.write(
    `aiolah serve — ${banner}\nworkspace ${workspaceRoot}, session ${main.session.sessionId}\n` +
      `Type here to chat in that session too. Ctrl+C to stop.\n\n`,
  );

  const hostRl = readline.createInterface({ input: stdin, output: stdout });
  while (true) {
    const input = await ask(hostRl, 'you> ');
    if (input === null) {
      // stdin closed (e.g. launched from a non-interactive npm script) — keep
      // serving remote clients; the process ends on Ctrl+C or when killed.
      stdout.write('[local stdin closed — serving remote clients only]\n');
      return new Promise<never>(() => {});
    }
    const trimmed = input.trim();
    if (!trimmed) {
      continue;
    }
    const waiting = [...runtimes.values()].find((runtime) => runtime.pendingConfirms.size > 0);
    if (waiting && /^[yn]$/i.test(trimmed)) {
      const [settle] = waiting.pendingConfirms.values();
      settle?.(trimmed.toLowerCase() === 'y');
      continue;
    }
    if (main.busy) {
      stdout.write('[busy — wait for the current turn to finish]\n');
      continue;
    }
    broadcast(main, { type: 'user', text: input });
    await runTurn(main, input, 'terminal');
  }
}

/** How a transport (direct or relay) hands clients to the session runtimes. */
interface ServeHooks {
  /** Attach a client to a session (none = main, `new`, or an id); null when it doesn't exist. */
  connect(peer: Peer, selector?: string): Promise<SessionRuntime | null>;
  message(runtime: SessionRuntime, peer: Peer, message: WireMessage): Promise<SessionRuntime>;
  disconnect(runtime: SessionRuntime, peer: Peer): void;
}

/** Registers (or refreshes) this machine + folder as a device on aiolah and returns its id. */
async function registerHost(auth: StoredAuth, workspaceRoot: string, name: string): Promise<number> {
  const server = serverUrl(auth);
  const registration = await apiRequest<{ host_id?: number }>(server, '/api/v1/app/cli/hosts', {
    method: 'POST',
    token: auth.token,
    body: { machine_id: machineIdFor(workspaceRoot), name, workspace: workspaceRoot },
  });
  if (registration.status === 401 || registration.status === 403) {
    throw new Error('Your aiolah login is no longer valid. Run `aiolah auth login` again.');
  }
  if (!registration.data.host_id) {
    throw new Error(`Could not register this machine with ${server} (HTTP ${registration.status}).`);
  }
  return registration.data.host_id;
}

/** Direct mode: listen on --port, clients answer an HMAC challenge with AIOLAH_REMOTE_TOKEN. */
function startDirect(options: ServeOptions, hooks: ServeHooks): string {
  const token = process.env.AIOLAH_REMOTE_TOKEN || randomBytes(16).toString('hex');
  const port = Number(options.port);
  const attemptsByIp = new Map<string, number[]>();

  const wss =
    options.cert && options.key
      ? new WebSocketServer({
          server: createHttpsServer({
            cert: readFileSync(options.cert),
            key: readFileSync(options.key),
          }).listen(port),
        })
      : new WebSocketServer({ port });

  wss.on('connection', (socket, request) => {
    const ip = request.socket.remoteAddress ?? 'unknown';
    if (isRateLimited(ip)) {
      send(socket, { type: 'error', text: 'rate limited' });
      socket.close();
      return;
    }

    const nonce = generateNonce();
    const peer: Peer = { send: (message) => send(socket, message) };
    let attempts = 0;
    let runtime: SessionRuntime | null = null;
    send(socket, { type: 'challenge', nonce });

    socket.on('message', (raw) => {
      void handleIncoming(raw.toString());
    });

    socket.on('close', () => {
      if (runtime) {
        hooks.disconnect(runtime, peer);
      }
    });

    async function handleIncoming(raw: string): Promise<void> {
      let message: WireMessage;
      try {
        message = JSON.parse(raw);
      } catch {
        send(socket, { type: 'error', text: 'invalid message' });
        return;
      }

      if (!runtime) {
        if (message.type !== 'auth') {
          send(socket, { type: 'error', text: 'expected auth' });
          return;
        }
        attempts += 1;
        recordAttempt(ip);
        if (attempts > MAX_AUTH_ATTEMPTS || !verifyChallenge(token, nonce, message.hmac)) {
          send(socket, { type: 'error', text: 'unauthorized' });
          socket.close();
          return;
        }
        runtime = await hooks.connect(peer);
        return;
      }

      runtime = await hooks.message(runtime, peer, message);
    }
  });

  function isRateLimited(ip: string): boolean {
    const now = Date.now();
    const attempts = (attemptsByIp.get(ip) ?? []).filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
    attemptsByIp.set(ip, attempts);
    return attempts.length >= RATE_LIMIT_MAX_ATTEMPTS;
  }

  function recordAttempt(ip: string): void {
    const attempts = attemptsByIp.get(ip) ?? [];
    attempts.push(Date.now());
    attemptsByIp.set(ip, attempts);
  }

  const scheme = options.cert && options.key ? 'wss' : 'ws';
  return (
    `direct mode, listening on ${scheme}://localhost:${port}\n` +
    `Share this token with attach clients (never sent over the wire): ${token}`
  );
}

/**
 * Relay mode: keep one outbound WebSocket to the aiolah relay open
 * (reconnecting with backoff). Each client the relay pairs with us becomes a
 * Peer addressed by its clientId, attached to the session it asked for.
 */
function startRelay(auth: StoredAuth, hostId: number, name: string, hooks: ServeHooks): string {
  const server = serverUrl(auth);
  const clients = new Map<string, { peer: Peer; runtime: SessionRuntime | null }>();
  let backoff = 1000;

  const connect = (): void => {
    const socket = new WebSocket(relayHostUrl(server), {
      headers: {
        Authorization: `Bearer ${auth.token}`,
        'X-Host-Id': String(hostId),
      },
    });
    let silenceTimer: NodeJS.Timeout | undefined;
    const resetSilenceTimer = () => {
      clearTimeout(silenceTimer);
      silenceTimer = setTimeout(() => socket.terminate(), RELAY_SILENCE_TIMEOUT_MS);
    };

    socket.on('open', () => {
      backoff = 1000;
      resetSilenceTimer();
      stdout.write('\n[connected to aiolah relay — open /code on aiolah to control this machine]\n');
    });
    socket.on('ping', resetSilenceTimer);

    socket.on('unexpected-response', (_request, response) => {
      if (response.statusCode === 401 || response.statusCode === 403) {
        stdout.write('\n[relay rejected this login — run `aiolah auth login` again]\n');
        process.exit(1);
      }
      socket.terminate();
    });

    socket.on('message', (raw) => {
      resetSilenceTimer();
      let frame: RelayFrame;
      try {
        frame = JSON.parse(raw.toString()) as RelayFrame;
      } catch {
        return;
      }

      if (frame.type === 'relay_client_joined') {
        const clientId = frame.clientId;
        const client = {
          peer: {
            send: (message: WireMessage) => {
              if (socket.readyState === WebSocket.OPEN) {
                socket.send(JSON.stringify({ type: 'relay_msg', to: clientId, msg: message } satisfies RelayFrame));
              }
            },
          },
          runtime: null as SessionRuntime | null,
        };
        clients.set(clientId, client);
        void hooks.connect(client.peer, frame.session).then((runtime) => {
          client.runtime = runtime;
        });
      } else if (frame.type === 'relay_client_left') {
        const client = clients.get(frame.clientId);
        if (client) {
          clients.delete(frame.clientId);
          if (client.runtime) {
            hooks.disconnect(client.runtime, client.peer);
          }
        }
      } else if (frame.type === 'relay_msg' && frame.from) {
        const client = clients.get(frame.from);
        if (client?.runtime) {
          void hooks.message(client.runtime, client.peer, frame.msg).then((runtime) => {
            client.runtime = runtime;
          });
        }
      }
    });

    socket.on('error', () => {
      // 'close' follows and schedules the reconnect.
    });

    socket.on('close', () => {
      clearTimeout(silenceTimer);
      for (const client of clients.values()) {
        if (client.runtime) {
          hooks.disconnect(client.runtime, client.peer);
        }
      }
      clients.clear();
      stdout.write(`\n[relay connection lost — retrying in ${Math.round(backoff / 1000)}s]\n`);
      setTimeout(connect, backoff);
      backoff = Math.min(backoff * 2, RELAY_BACKOFF_MAX_MS);
    });
  };

  connect();

  return `relay mode via ${server} as "${name}" (logged in as ${auth.user.email})`;
}

function send(socket: WebSocket, message: WireMessage): void {
  socket.send(JSON.stringify(message));
}
