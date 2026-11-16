import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { auth, UnauthorizedError, type OAuthClientProvider, type OAuthDiscoveryState } from '@modelcontextprotocol/sdk/client/auth.js';
import type { OAuthClientInformationMixed, OAuthTokens, OAuthClientMetadata } from '@modelcontextprotocol/sdk/shared/auth.js';
import { encrypt, decrypt, isEncryptionConfigured } from './credential-encryption.js';
import { mcpClientManager } from './mcp-client.js';
import type { MCPRepository } from '../repositories/mcp-types.js';

/**
 * Interactive MCP OAuth (Authorization Code + PKCE), reusing the MCP SDK's standards-compliant
 * `auth()` orchestrator (RFC 9728 protected-resource discovery, RFC 8414 AS metadata, RFC 7591
 * dynamic client registration, PKCE, token exchange + refresh).
 *
 * Flow: Connect -> start() discovers + registers + builds the authorization URL and returns it;
 * the UI opens it in the user's browser; the provider redirects to a loopback callback; the
 * callback validates `state`, exchanges the code (PKCE), stores tokens encrypted, and reconnects.
 *
 * Security: tokens/client secrets are persisted only as an encrypted envelope (encryption must be
 * configured); no secrets in URLs/logs/UI; per-server sessions keyed by random `state` prevent
 * cross-session confusion; resource/audience selection is handled by the SDK (RFC 8707).
 */

export type OAuthStatus = 'none' | 'pending' | 'authorized' | 'error';

export interface OAuthSession {
  serverId: string;
  serverUrl: string;
  state?: string;
  codeVerifier?: string;
  clientInformation?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  discovery?: OAuthDiscoveryState;
  authorizationUrl?: string;
  status: OAuthStatus;
  error?: string;
}

interface PersistedOAuth {
  clientInformation?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  discovery?: OAuthDiscoveryState;
}

class BoardOAuthProvider implements OAuthClientProvider {
  constructor(private session: OAuthSession, private manager: McpOAuthManager) {}

  get redirectUrl(): string {
    return this.manager.getRedirectUrl();
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: 'AI Agent Board',
      redirect_uris: [this.manager.getRedirectUrl()],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      scope: this.manager.requestedScope(this.session),
    };
  }

  state(): string {
    if (!this.session.state) this.session.state = randomUUID();
    return this.session.state;
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    return this.session.clientInformation;
  }

  saveClientInformation(info: OAuthClientInformationMixed): void {
    this.session.clientInformation = info;
    this.manager.persist(this.session);
  }

  tokens(): OAuthTokens | undefined {
    return this.session.tokens;
  }

  saveTokens(tokens: OAuthTokens): void {
    this.session.tokens = tokens;
    this.manager.persist(this.session);
  }

  redirectToAuthorization(url: URL): void {
    this.session.authorizationUrl = url.toString();
    this.session.status = 'pending';
  }

  saveCodeVerifier(verifier: string): void {
    this.session.codeVerifier = verifier;
  }

  codeVerifier(): string {
    if (!this.session.codeVerifier) throw new Error('Missing PKCE code verifier for this session');
    return this.session.codeVerifier;
  }

  saveDiscoveryState(state: OAuthDiscoveryState): void {
    this.session.discovery = state;
  }

  discoveryState(): OAuthDiscoveryState | undefined {
    return this.session.discovery;
  }

  invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): void {
    if (scope === 'all' || scope === 'tokens') this.session.tokens = undefined;
    if (scope === 'all' || scope === 'client') this.session.clientInformation = undefined;
    if (scope === 'all' || scope === 'verifier') this.session.codeVerifier = undefined;
    if (scope === 'all' || scope === 'discovery') this.session.discovery = undefined;
    this.manager.persist(this.session);
  }
}

export class McpOAuthManager {
  private sessions = new Map<string, OAuthSession>();
  private providers = new Map<string, BoardOAuthProvider>();
  private callbackServer: Server | null = null;
  private callbackPort = 0;

  constructor(private repo: MCPRepository) {}

  /** Scope selection: resource scopes + offline_access when the AS supports refresh. */
  requestedScope(session: OAuthSession): string {
    const resourceScopes = session.discovery?.resourceMetadata?.scopes_supported;
    const as = session.discovery?.authorizationServerMetadata;
    const scopes = resourceScopes?.length ? [...resourceScopes] : ['openid', 'profile', 'email'];
    if (as?.grant_types_supported?.includes('refresh_token') && !scopes.includes('offline_access')) {
      scopes.push('offline_access');
    }
    return scopes.join(' ');
  }

  getRedirectUrl(): string {
    return `http://127.0.0.1:${this.callbackPort}/oauth/callback`;
  }

  private async ensureCallbackServer(): Promise<void> {
    if (this.callbackServer) return;
    this.callbackServer = createServer((req, res) => { void this.handleCallback(req, res); });
    await new Promise<void>((resolve) => this.callbackServer!.listen(0, '127.0.0.1', resolve));
    const addr = this.callbackServer.address();
    this.callbackPort = typeof addr === 'object' && addr ? addr.port : 0;
  }

  private providerFor(session: OAuthSession): BoardOAuthProvider {
    let p = this.providers.get(session.serverId);
    if (!p) { p = new BoardOAuthProvider(session, this); this.providers.set(session.serverId, p); }
    return p;
  }

  /** Load persisted (encrypted) OAuth state into a session, if any. */
  private async loadSession(serverId: string, serverUrl: string): Promise<OAuthSession> {
    let session = this.sessions.get(serverId);
    if (!session) {
      session = { serverId, serverUrl, status: 'none' };
      this.sessions.set(serverId, session);
    }
    session.serverUrl = serverUrl;
    if (!session.tokens && !session.clientInformation) {
      const raw = await this.repo.getOAuthData(serverId);
      if (raw) {
        const json = isEncryptionConfigured() ? decrypt(raw) : null;
        if (json) {
          try {
            const data = JSON.parse(json) as PersistedOAuth;
            session.clientInformation = data.clientInformation;
            session.tokens = data.tokens;
            session.discovery = data.discovery;
            if (data.tokens) session.status = 'authorized';
          } catch { /* ignore corrupt persisted state */ }
        }
      }
    }
    return session;
  }

  /** Persist tokens/client/discovery as an encrypted envelope. Requires encryption to be
   *  configured; otherwise the state stays in-memory only (never persisted in plaintext). */
  persist(session: OAuthSession): void {
    if (!isEncryptionConfigured()) return; // no plaintext persistence of real credentials
    const data: PersistedOAuth = {
      clientInformation: session.clientInformation,
      tokens: session.tokens,
      discovery: session.discovery,
    };
    const enc = encrypt(JSON.stringify(data));
    if (enc) void this.repo.setOAuthData(session.serverId, enc).catch(() => {});
  }

  /** Begin (or resume) authorization. Returns the authorization URL for the browser when a
   *  redirect is required, or reports already-authorized. */
  async start(serverId: string, serverUrl: string): Promise<{ status: OAuthStatus; authorizationUrl?: string; error?: string }> {
    const session = await this.loadSession(serverId, serverUrl);
    await this.ensureCallbackServer();
    const provider = this.providerFor(session);
    try {
      const result = await auth(provider, { serverUrl });
      if (result === 'AUTHORIZED') {
        session.status = 'authorized';
        session.error = undefined;
        await this.reconnect(serverId);
        return { status: 'authorized' };
      }
      // REDIRECT: authorizationUrl recorded by redirectToAuthorization.
      session.status = 'pending';
      return { status: 'pending', authorizationUrl: session.authorizationUrl };
    } catch (err) {
      if (err instanceof UnauthorizedError && session.authorizationUrl) {
        session.status = 'pending';
        return { status: 'pending', authorizationUrl: session.authorizationUrl };
      }
      session.status = 'error';
      session.error = err instanceof Error ? err.message : String(err);
      return { status: 'error', error: session.error };
    }
  }

  /** Handle the loopback OAuth callback: validate state, exchange code, reconnect. */
  private async handleCallback(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${this.callbackPort}`);
    if (url.pathname !== '/oauth/callback') { res.writeHead(404); res.end(); return; }
    const state = url.searchParams.get('state');
    const code = url.searchParams.get('code');
    const oauthError = url.searchParams.get('error');

    const session = state ? [...this.sessions.values()].find((s) => s.state === state) : undefined;
    if (!session) {
      res.writeHead(400, { 'content-type': 'text/html' });
      res.end('<html><body><h3>Invalid or expired authorization state.</h3><p>Return to the Board and retry.</p></body></html>');
      return;
    }
    if (oauthError || !code) {
      session.status = 'error';
      session.error = oauthError ?? 'missing authorization code';
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(`<html><body><h3>Authorization cancelled or denied.</h3><p>${escapeHtml(session.error)}</p><p>You may close this window.</p></body></html>`);
      return;
    }
    try {
      const provider = this.providerFor(session);
      const result = await auth(provider, { serverUrl: session.serverUrl, authorizationCode: code });
      if (result === 'AUTHORIZED') {
        session.status = 'authorized';
        session.error = undefined;
        session.state = undefined; // single-use state
        await this.reconnect(serverIdOf(session));
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('<html><body><h3>Authorized.</h3><p>You may close this window and return to the Board.</p></body></html>');
      } else {
        session.status = 'pending';
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('<html><body><h3>Authorization in progress.</h3><p>Return to the Board.</p></body></html>');
      }
    } catch (err) {
      session.status = 'error';
      session.error = err instanceof Error ? err.message : String(err);
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(`<html><body><h3>Authorization failed.</h3><p>${escapeHtml(session.error)}</p></body></html>`);
    }
  }

  /** Reconnect the MCP server using the OAuth provider (tokens + automatic refresh). */
  async reconnect(serverId: string): Promise<void> {
    const record = await this.repo.getServerById(serverId);
    if (!record || !record.url) return;
    const session = this.sessions.get(serverId);
    const provider = session ? this.providerFor(session) : undefined;
    try {
      await mcpClientManager.connect({
        id: record.id, name: record.name, transport: record.transport as any,
        url: record.url, headers: record.headers, env: record.env,
        authProvider: provider,
      });
      await this.repo.updateServer(serverId, { status: 'connected', last_error: undefined });
    } catch (err) {
      await this.repo.updateServer(serverId, { status: 'error', last_error: err instanceof Error ? err.message : String(err) });
    }
  }

  async status(serverId: string): Promise<{ status: OAuthStatus; error?: string; hasTokens: boolean }> {
    const session = this.sessions.get(serverId);
    if (session) return { status: session.status, error: session.error, hasTokens: Boolean(session.tokens) };
    const raw = await this.repo.getOAuthData(serverId);
    return { status: raw ? 'authorized' : 'none', hasTokens: Boolean(raw) };
  }

  /** Revoke stored authorization and disconnect. */
  async revoke(serverId: string): Promise<void> {
    await this.repo.deleteOAuthData(serverId);
    const session = this.sessions.get(serverId);
    if (session) {
      session.tokens = undefined;
      session.clientInformation = undefined;
      session.codeVerifier = undefined;
      session.state = undefined;
      session.status = 'none';
      session.error = undefined;
    }
    await mcpClientManager.disconnect(serverId);
    await this.repo.updateServer(serverId, { status: 'disconnected', last_error: undefined });
  }

  async shutdown(): Promise<void> {
    if (this.callbackServer) {
      await new Promise<void>((resolve) => this.callbackServer!.close(() => resolve()));
      this.callbackServer = null;
    }
  }

  /** Provider to attach on a normal connect when this server already has OAuth tokens. */
  async getAuthorizedProvider(serverId: string): Promise<OAuthClientProvider | undefined> {
    const record = await this.repo.getServerById(serverId);
    if (!record?.url) return undefined;
    const session = await this.loadSession(serverId, record.url);
    return session.tokens ? this.providerFor(session) : undefined;
  }
}

function serverIdOf(session: OAuthSession): string {
  return session.serverId;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}
