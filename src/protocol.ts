/** An image attached to a prompt (base64, no data: prefix). */
export interface ImageInput {
  media_type: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
  data: string;
}

export interface ModelOption {
  id: string;
  name?: string;
}

export type HistoryItem =
  | { role: 'user'; text: string; images?: number }
  | { role: 'assistant'; text: string }
  | { role: 'tool'; name: string; input: unknown; result: string };

export type WireMessage =
  | { type: 'challenge'; nonce: string }
  | { type: 'auth'; hmac: string }
  | {
      type: 'authed';
      sessionId: string;
      /** aiolah session uuid when the host reports sessions (signed in); null otherwise. */
      sessionUuid?: string | null;
      workspace: string;
      model: string;
      /** Provider id the session uses (`aiolah`, `openrouter`, …). */
      provider?: string;
      history: HistoryItem[];
    }
  /** Direct mode: switch this connection to another session (`new` starts one). */
  | { type: 'open_session'; session: string }
  /** Client → host: `images` (optional) are attached; host → clients: only `imageCount`. */
  | { type: 'user'; text: string; images?: ImageInput[]; imageCount?: number }
  /**
   * Host → clients (0.1.4+): the answer while it is written, in pieces, including
   * text before tool calls. The complete reply still follows as `assistant`.
   */
  | { type: 'assistant_delta'; text: string }
  | { type: 'assistant'; text: string }
  /** Client → host: models the session's provider offers; answered with `models`. */
  | { type: 'list_models' }
  | { type: 'models'; provider: string; current: string; models: ModelOption[] }
  /** Client → host: switch this session's model (only while idle); broadcast as `model`. */
  | { type: 'set_model'; model: string }
  | { type: 'model'; provider: string; model: string }
  /** Client → host: stop the running turn; clients then get `interrupted` and `idle`. */
  | { type: 'interrupt' }
  | { type: 'interrupted' }
  | { type: 'tool'; name: string; input: unknown }
  | { type: 'tool_result'; name: string; result: string }
  | { type: 'confirm'; id: string; description: string }
  | { type: 'confirm_reply'; id: string; allow: boolean }
  | { type: 'busy' }
  | { type: 'idle' }
  | { type: 'error'; text: string };

/**
 * Frames between `aiolah serve` (relay mode) and `aiolah relay` only. Clients
 * never see them: the relay unwraps `relay_msg` and forwards the inner
 * WireMessage, so web/mobile/VS Code speak the same protocol as a direct
 * connection (minus the challenge, which the relay's ticket replaces).
 */
export type RelayFrame =
  /** `session`: id of a host session to join, `new` for a fresh one, absent = the host's main session. */
  | { type: 'relay_client_joined'; clientId: string; session?: string }
  | { type: 'relay_client_left'; clientId: string }
  | { type: 'relay_msg'; from?: string; to?: string; msg: WireMessage };

/**
 * Collects streamed text for `assistant_delta` and sends it at most every
 * `intervalMs`, so a fast model doesn't cost one WebSocket message per token.
 * `flush()` sends what is pending right away; call it before any other
 * message about the same turn so the order stays right.
 */
export class TextBatcher {
  private pending = '';
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly send: (text: string) => void,
    private readonly intervalMs = 50,
  ) {}

  push(text: string): void {
    this.pending += text;
    this.timer ??= setTimeout(() => this.flush(), this.intervalMs);
  }

  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (!this.pending) return;
    const text = this.pending;
    this.pending = '';
    this.send(text);
  }
}

/** Session selector accepted from clients: a local session id or `new`. */
export const SESSION_SELECTOR = /^(new|[A-Za-z0-9._-]{1,64})$/;
