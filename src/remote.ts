import WebSocket from 'ws';
import { apiRequest, machineIdFor, relayHostUrl, serverUrl, type StoredAuth } from './config.js';
import { listProviderModels, providerDef } from './providers.js';
import { fetchModels } from './models.js';
import type { ImageInput, ModelOption, RelayFrame, WireMessage } from './protocol.js';

/** A connected, authenticated client — a direct WebSocket or one relayed through aiolah. */
export interface Peer {
  send(message: WireMessage): void;
}

/** How a transport (direct or relay) hands clients to whatever serves them (`R`: the client's session). */
export interface RemoteHooks<R> {
  /** Attach a client to a session (none = the main one, `new`, or an id); null when it doesn't exist. */
  connect(peer: Peer, selector?: string): Promise<R | null>;
  message(runtime: R, peer: Peer, message: WireMessage): Promise<R>;
  disconnect(runtime: R, peer: Peer): void;
}

const RELAY_BACKOFF_MAX_MS = 30_000;
const RELAY_SILENCE_TIMEOUT_MS = 75_000;
export const MAX_IMAGES = 4;
/** Base64 characters across all images of one prompt; keeps a frame under the relay's 4 MB limit. */
const MAX_IMAGE_CHARS = 3_500_000;
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

/** Attached images if they are acceptable, [] for none, null when they are not. */
export function validImages(images: unknown): ImageInput[] | null {
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
export async function listModelOptions(provider: string): Promise<ModelOption[]> {
  if (providerDef(provider).kind === 'aiolah') {
    return (await fetchModels()).data.map((model) => ({ id: model.id, name: model.name }));
  }
  return (await listProviderModels(provider)).map((id) => ({ id }));
}

/** Registers (or refreshes) this machine + folder as a device on aiolah and returns its id. */
export async function registerHost(auth: StoredAuth, workspaceRoot: string, name: string): Promise<number> {
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

export interface RelayConnection {
  /** Closes the relay connection for good (the device shows as offline on /code). */
  stop(): void;
}

/**
 * Relay mode: keep one outbound WebSocket to the aiolah relay open
 * (reconnecting with backoff). Each client the relay pairs with us becomes a
 * Peer addressed by its clientId, attached to the session it asked for.
 * `log` receives status lines (connected, connection lost, …); `onRejected`
 * runs when the relay refuses the login (the connection then stays closed).
 */
export function startRelay<R>(
  auth: StoredAuth,
  hostId: number,
  hooks: RemoteHooks<R>,
  log: (line: string) => void,
  onRejected?: () => void,
): RelayConnection {
  const server = serverUrl(auth);
  const clients = new Map<string, { peer: Peer; runtime: R | null }>();
  let backoff = 1000;
  let stopped = false;
  let current: WebSocket | null = null;
  let reconnectTimer: NodeJS.Timeout | undefined;

  const connect = (): void => {
    const socket = new WebSocket(relayHostUrl(server), {
      headers: {
        Authorization: `Bearer ${auth.token}`,
        'X-Host-Id': String(hostId),
      },
    });
    current = socket;
    let silenceTimer: NodeJS.Timeout | undefined;
    const resetSilenceTimer = () => {
      clearTimeout(silenceTimer);
      silenceTimer = setTimeout(() => socket.terminate(), RELAY_SILENCE_TIMEOUT_MS);
    };

    socket.on('open', () => {
      backoff = 1000;
      resetSilenceTimer();
      log('connected to aiolah relay — open /code on aiolah to control this machine');
    });
    socket.on('ping', resetSilenceTimer);

    socket.on('unexpected-response', (_request, response) => {
      if (response.statusCode === 401 || response.statusCode === 403) {
        log('relay rejected this login — run `aiolah auth login` again');
        stopped = true;
        onRejected?.();
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
          runtime: null as R | null,
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
      if (stopped) {
        return;
      }
      log(`relay connection lost — retrying in ${Math.round(backoff / 1000)}s`);
      reconnectTimer = setTimeout(connect, backoff);
      backoff = Math.min(backoff * 2, RELAY_BACKOFF_MAX_MS);
    });
  };

  connect();

  return {
    stop: () => {
      stopped = true;
      clearTimeout(reconnectTimer);
      current?.close();
    },
  };
}
