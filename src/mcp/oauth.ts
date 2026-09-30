import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';

/**
 * OAuth for remote (http/sse) MCP servers that require a sign-in, as
 * `claude mcp` does: `aiolah mcp auth <name>` opens the server's login in the
 * browser, a one-time local callback receives the code, and the tokens are
 * kept in ~/.aiolah/mcp-oauth.json (0600, per server and URL). The MCP SDK
 * registers the client, adds the token to requests and refreshes it.
 */
const OAUTH_FILE = join(homedir(), '.aiolah', 'mcp-oauth.json');

/** Fixed so the redirect URI registered with the server stays the same; AIOLAH_MCP_OAUTH_PORT overrides it. */
export const CALLBACK_PORT = Number(process.env.AIOLAH_MCP_OAUTH_PORT) || 19876;

interface StoredServer {
  clientInformation?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  codeVerifier?: string;
}

function readAll(): Record<string, StoredServer> {
  try {
    return JSON.parse(readFileSync(OAUTH_FILE, 'utf8')) as Record<string, StoredServer>;
  } catch {
    return {};
  }
}

function writeAll(all: Record<string, StoredServer>): void {
  mkdirSync(join(homedir(), '.aiolah'), { recursive: true, mode: 0o700 });
  writeFileSync(OAUTH_FILE, `${JSON.stringify(all, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  chmodSync(OAUTH_FILE, 0o600);
}

function keyFor(name: string, url: string): string {
  return `${name}|${url}`;
}

/** Whether aiolah holds tokens for this server. */
export function hasOAuthTokens(name: string, url: string): boolean {
  return Boolean(readAll()[keyFor(name, url)]?.tokens);
}

/** `aiolah mcp logout <name>`: forgets the server's tokens and client registration. */
export function forgetOAuth(name: string, url: string): boolean {
  const all = readAll();
  const key = keyFor(name, url);
  if (!all[key]) return false;
  delete all[key];
  writeAll(all);
  return true;
}

export class StoredOAuthProvider implements OAuthClientProvider {
  /** Set when the server needs a (new) sign-in: where to send the user. */
  authorizationUrl: URL | null = null;

  constructor(
    private readonly name: string,
    private readonly url: string,
  ) {}

  get redirectUrl(): string {
    return `http://127.0.0.1:${CALLBACK_PORT}/callback`;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: 'aiolah CLI',
      redirect_uris: [this.redirectUrl],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    };
  }

  private read(): StoredServer {
    return readAll()[keyFor(this.name, this.url)] ?? {};
  }

  private update(change: (entry: StoredServer) => void): void {
    const all = readAll();
    const key = keyFor(this.name, this.url);
    const entry = all[key] ?? {};
    change(entry);
    all[key] = entry;
    writeAll(all);
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    return this.read().clientInformation;
  }

  saveClientInformation(clientInformation: OAuthClientInformationMixed): void {
    this.update((entry) => (entry.clientInformation = clientInformation));
  }

  tokens(): OAuthTokens | undefined {
    return this.read().tokens;
  }

  saveTokens(tokens: OAuthTokens): void {
    this.update((entry) => (entry.tokens = tokens));
  }

  redirectToAuthorization(authorizationUrl: URL): void {
    this.authorizationUrl = authorizationUrl;
  }

  saveCodeVerifier(codeVerifier: string): void {
    this.update((entry) => (entry.codeVerifier = codeVerifier));
  }

  codeVerifier(): string {
    const verifier = this.read().codeVerifier;
    if (!verifier) {
      throw new Error('No sign-in in progress for this MCP server.');
    }
    return verifier;
  }

  invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): void {
    this.update((entry) => {
      if (scope === 'all' || scope === 'client') delete entry.clientInformation;
      if (scope === 'all' || scope === 'tokens') delete entry.tokens;
      if (scope === 'all' || scope === 'verifier') delete entry.codeVerifier;
    });
  }
}

/**
 * Listens on the local callback for the browser to come back; `code` resolves
 * to the authorization code, `close` stops listening early.
 */
export function listenForAuthorizationCode(timeoutMs = 5 * 60_000): { code: Promise<string>; close: () => void } {
  let close = () => {};
  const code = new Promise<string>((resolveCode, reject) => {
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? '/', `http://127.0.0.1:${CALLBACK_PORT}`);
      if (url.pathname !== '/callback') {
        response.writeHead(404).end();
        return;
      }
      const code = url.searchParams.get('code');
      const error = url.searchParams.get('error');
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end(
        code
          ? '<p>aiolah is signed in to the MCP server. You can close this tab.</p>'
          : `<p>Sign-in failed: ${String(error ?? 'no code')}.</p>`,
      );
      clearTimeout(timer);
      server.close();
      if (code) resolveCode(code);
      else reject(new Error(`Sign-in failed: ${String(error ?? 'no code')}`));
    });
    const timer = setTimeout(() => {
      server.close();
      reject(new Error('Timed out waiting for the browser sign-in.'));
    }, timeoutMs);
    server.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    server.listen(CALLBACK_PORT, '127.0.0.1');
    close = () => {
      clearTimeout(timer);
      server.close();
    };
  });
  return { code, close: () => close() };
}
