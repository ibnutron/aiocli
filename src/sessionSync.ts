import type { ChatSession, PromptOrigin } from './session.js';
import { apiRequest, readAuth, serverUrl, type StoredAuth } from './config.js';

type SyncEvent =
  | { type: 'message'; role: 'user' | 'assistant'; text: string; origin?: PromptOrigin }
  | { type: 'tool'; name: string; input: unknown }
  | { type: 'tool_result'; name: string; result: string }
  | { type: 'status'; state: 'working' | 'needs_input' | 'idle'; has_changes?: boolean };

const MUTATING_TOOLS = new Set(['write_file', 'edit_file', 'run_bash']);
const MAX_RESULT_CHARS = 20_000;
const MAX_QUEUE = 2_000;
const BATCH_SIZE = 100;
const FLUSH_DELAY_MS = 300;
const MAX_BACKOFF_MS = 30_000;

/**
 * Reports one ChatSession to aiolah (the Sessions list on /code, the app and
 * VS Code): registers it, then streams transcript and status events in the
 * background. Never blocks a turn — failures are retried with backoff and
 * the session keeps working offline.
 */
export class SessionSync {
  /** aiolah session uuid, or null when registration failed. */
  /** The session's uuid on aiolah (re-registered when /clear or /resume switches the conversation). */
  ready: Promise<string | null>;
  private readonly queue: SyncEvent[] = [];
  private timer: NodeJS.Timeout | undefined;
  private flushing = false;
  private backoff = 1000;
  private turnHasChanges = false;

  private constructor(
    private readonly auth: StoredAuth,
    private readonly session: ChatSession,
    private readonly meta: { hostId?: number; origin: PromptOrigin },
  ) {
    this.ready = this.register(meta);
    this.listen();
  }

  /** Starts syncing when the CLI is signed in to aiolah; otherwise returns null. */
  static attach(session: ChatSession, meta: { hostId?: number; origin: PromptOrigin }): SessionSync | null {
    const auth = readAuth();
    return auth ? new SessionSync(auth, session, meta) : null;
  }

  /** Links the session to a device on aiolah (after /remote-control in chat), so /code lists it there. */
  linkHost(hostId: number): void {
    this.meta.hostId = hostId;
    void this.register(this.meta);
  }

  private async register(meta: { hostId?: number; origin: PromptOrigin }): Promise<string | null> {
    try {
      const response = await apiRequest<{ uuid?: string }>(serverUrl(this.auth), '/api/v1/app/cli/sessions', {
        method: 'POST',
        token: this.auth.token,
        body: {
          cli_session_id: this.session.sessionId,
          code_host_id: meta.hostId,
          workspace: this.session.workspace,
          model_key: this.session.modelId,
          origin: meta.origin,
        },
      });
      return response.data.uuid ?? null;
    } catch {
      return null;
    }
  }

  /** /clear or /resume: finish sending the old conversation, then register the new one. */
  private async switchSession(): Promise<void> {
    await this.flush();
    this.queue.length = 0;
    this.ready = this.register(this.meta);
  }

  private listen(): void {
    this.session.on('session_changed', () => void this.switchSession());
    this.session.on(
      'turn_start',
      ({ text, origin, images }: { text: string; origin: PromptOrigin; images?: number }) => {
        this.turnHasChanges = false;
        this.push({ type: 'status', state: 'working' });
        const attached = images ? `\n\n[${images} image${images === 1 ? '' : 's'} attached]` : '';
        this.push({ type: 'message', role: 'user', text: `${text}${attached}`, origin });
      },
    );
    this.session.on('tool', ({ name, input }: { name: string; input: unknown }) => {
      this.push({ type: 'tool', name, input });
    });
    this.session.on('tool_result', ({ name, result }: { name: string; result: string }) => {
      if (MUTATING_TOOLS.has(name) && !/^(User declined|Error:)/.test(result)) {
        this.turnHasChanges = true;
      }
      this.push({ type: 'tool_result', name, result: result.slice(0, MAX_RESULT_CHARS) });
    });
    this.session.on('confirm_wait', () => this.push({ type: 'status', state: 'needs_input' }));
    this.session.on('confirm_done', () => this.push({ type: 'status', state: 'working' }));
    this.session.on('turn_end', ({ reply }: { reply: string }) => {
      if (reply.trim()) {
        this.push({ type: 'message', role: 'assistant', text: reply });
      }
      this.push({ type: 'status', state: 'idle', has_changes: this.turnHasChanges });
    });
    this.session.on('turn_error', ({ message }: { message: string }) => {
      this.push({ type: 'message', role: 'assistant', text: `Error: ${message}` });
      this.push({ type: 'status', state: 'idle', has_changes: this.turnHasChanges });
    });
  }

  private push(event: SyncEvent): void {
    if (this.queue.length >= MAX_QUEUE) {
      this.queue.shift();
    }
    this.queue.push(event);
    this.schedule(FLUSH_DELAY_MS);
  }

  private schedule(delay: number): void {
    if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = undefined;
        void this.flush();
      }, delay);
    }
  }

  /** Sends queued events now; resolves when the queue is empty or the server is unreachable. */
  async flush(): Promise<void> {
    if (this.flushing) {
      return;
    }
    this.flushing = true;
    try {
      const uuid = await this.ready;
      while (uuid && this.queue.length > 0) {
        const batch = this.queue.slice(0, BATCH_SIZE);
        let status: number;
        try {
          status = (
            await apiRequest(serverUrl(this.auth), `/api/v1/app/cli/sessions/${uuid}/events`, {
              method: 'POST',
              token: this.auth.token,
              body: { events: batch },
            })
          ).status;
        } catch {
          status = 0;
        }

        if (status >= 200 && status < 300) {
          this.queue.splice(0, batch.length);
          this.backoff = 1000;
          continue;
        }
        if (status >= 400 && status < 500 && status !== 429) {
          // Rejected (validation / auth): drop it instead of retrying forever.
          this.queue.splice(0, batch.length);
          continue;
        }
        this.schedule(this.backoff);
        this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF_MS);
        return;
      }
      if (!uuid) {
        this.queue.length = 0;
      }
    } finally {
      this.flushing = false;
    }
  }
}
