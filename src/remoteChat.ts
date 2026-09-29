import { randomBytes } from 'node:crypto';
import type { ChatSession, PromptOrigin } from './session.js';
import type { SessionSync } from './sessionSync.js';
import type { StoredAuth } from './config.js';
import type { ImageInput, WireMessage } from './protocol.js';
import {
  MAX_IMAGES,
  listModelOptions,
  registerHost,
  startRelay,
  validImages,
  type Peer,
  type RelayConnection,
} from './remote.js';

/** What `aiolah chat` does for its remote clients. */
export interface ChatRemoteUi {
  /** Runs a prompt from a client as a turn of the chat (shown like a typed message). */
  runTurn(text: string, images: ImageInput[]): void;
  /** A status line (connected, connection lost, …). */
  notice(line: string): void;
  /** The model was switched from a client. */
  modelChanged(): void;
  /** A client stopped the running turn. */
  interrupted(): void;
}

/** An Allow/Deny question sent to the clients; `cancel` withdraws it once the terminal answered. */
export interface RemoteQuestion {
  answer: Promise<boolean>;
  cancel(): void;
}

/**
 * `/remote-control` inside `aiolah chat` (as in Claude Code): registers this
 * folder as a device on aiolah and shares the running chat session through
 * the relay, so /code, the app or VS Code can follow it, send prompts and
 * answer Allow/Deny questions. Only this one session is shared; `aiolah rc`
 * serves several.
 */
export class ChatRemote {
  private readonly peers = new Set<Peer>();
  private readonly questions = new Map<string, (allow: boolean) => void>();
  private relay: RelayConnection | null = null;

  constructor(
    private readonly session: ChatSession,
    private readonly sync: SessionSync | null,
    private readonly ui: ChatRemoteUi,
  ) {
    this.listen();
  }

  get active(): boolean {
    return this.relay !== null;
  }

  /** Registers the device and connects to the relay; returns what to tell the user. */
  async start(auth: StoredAuth, name: string): Promise<string> {
    const hostId = await registerHost(auth, this.session.workspace, name);
    this.session.hostId = hostId;
    this.sync?.linkHost(hostId);
    this.relay = startRelay(
      auth,
      hostId,
      {
        connect: async (peer, selector) => this.connect(peer, selector),
        message: async (_runtime, peer, message) => {
          await this.handle(peer, message);
          return true as const;
        },
        disconnect: (_runtime, peer) => {
          this.peers.delete(peer);
        },
      },
      (line) => this.ui.notice(line),
      () => this.stop(),
    );
    return `Remote Control is on as "${name}" — open /code on aiolah to follow and control this chat.`;
  }

  stop(): void {
    this.relay?.stop();
    this.relay = null;
    this.peers.clear();
    for (const settle of [...this.questions.values()]) {
      settle(false);
    }
  }

  /** Asks the connected clients too; null when nobody is connected. */
  ask(description: string): RemoteQuestion | null {
    if (!this.peers.size) {
      return null;
    }
    const id = randomBytes(6).toString('hex');
    const answer = new Promise<boolean>((resolve) => {
      this.questions.set(id, (allow) => {
        this.questions.delete(id);
        resolve(allow);
      });
    });
    this.broadcast({ type: 'confirm', id, description });
    return { answer, cancel: () => this.questions.delete(id) };
  }

  private async connect(peer: Peer, selector?: string): Promise<true | null> {
    if (selector && selector !== this.session.sessionId) {
      peer.send({
        type: 'error',
        text:
          'This device shares one chat session (/remote-control). ' +
          'Run "aiolah rc" in that folder for more sessions.',
      });
      return null;
    }
    this.peers.add(peer);
    peer.send({
      type: 'authed',
      sessionId: this.session.sessionId,
      sessionUuid: this.sync ? await this.sync.ready : null,
      workspace: this.session.workspace,
      model: this.session.modelId,
      provider: this.session.providerId,
      history: this.session.renderHistory(),
    });
    if (this.session.isRunning) {
      peer.send({ type: 'busy' });
    }
    return true;
  }

  private async handle(peer: Peer, message: WireMessage): Promise<void> {
    switch (message.type) {
      case 'open_session':
        this.peers.delete(peer);
        await this.connect(peer, message.session);
        return;
      case 'confirm_reply':
        this.questions.get(message.id)?.(message.allow);
        return;
      case 'list_models':
        try {
          peer.send({
            type: 'models',
            provider: this.session.providerId,
            current: this.session.modelId,
            models: await listModelOptions(this.session.providerId),
          });
        } catch (error) {
          peer.send({ type: 'error', text: error instanceof Error ? error.message : String(error) });
        }
        return;
      case 'set_model': {
        const model = String(message.model ?? '').trim();
        if (this.session.isRunning) {
          peer.send({ type: 'error', text: 'busy' });
        } else if (!model || model.length > 200) {
          peer.send({ type: 'error', text: 'invalid model' });
        } else {
          this.session.useModel(this.session.providerId, model);
          this.broadcast({ type: 'model', provider: this.session.providerId, model });
          this.ui.modelChanged();
        }
        return;
      }
      case 'interrupt':
        if (this.session.interrupt()) {
          for (const settle of [...this.questions.values()]) {
            settle(false);
          }
          this.ui.interrupted();
        }
        return;
      case 'user': {
        if (this.session.isRunning) {
          peer.send({ type: 'error', text: 'busy' });
          return;
        }
        const images = validImages(message.images);
        if (images === null) {
          peer.send({
            type: 'error',
            text: `Attach at most ${MAX_IMAGES} PNG, JPEG, GIF or WebP images under 3 MB each.`,
          });
          return;
        }
        this.broadcast({ type: 'user', text: message.text, imageCount: images.length || undefined }, peer);
        this.ui.runTurn(message.text, images);
        return;
      }
      default:
        return;
    }
  }

  /** Mirrors the session to the clients (prompts typed in the terminal, tools, answers). */
  private listen(): void {
    this.session.on('turn_start', ({ text, origin }: { text: string; origin: PromptOrigin }) => {
      this.broadcast({ type: 'busy' });
      if (origin !== 'remote') {
        this.broadcast({ type: 'user', text });
      }
    });
    this.session.on('tool', ({ name, input }: { name: string; input: unknown }) => {
      this.broadcast({ type: 'tool', name, input });
    });
    this.session.on('tool_result', ({ name, result }: { name: string; result: string }) => {
      this.broadcast({ type: 'tool_result', name, result });
    });
    this.session.on('turn_end', ({ reply }: { reply: string }) => {
      this.broadcast({ type: 'assistant', text: reply });
      this.broadcast({ type: 'idle' });
    });
    this.session.on('turn_error', ({ message }: { message: string }) => {
      this.broadcast(message === 'Interrupted' ? { type: 'interrupted' } : { type: 'error', text: message });
      this.broadcast({ type: 'idle' });
    });
  }

  private broadcast(message: WireMessage, except?: Peer): void {
    for (const peer of this.peers) {
      if (peer !== except) {
        peer.send(message);
      }
    }
  }
}
