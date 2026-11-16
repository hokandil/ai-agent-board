import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer, type Server } from 'node:http';
import { randomUUID, createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp';
import { migrateSqliteDatabase } from '../src/db.js';
import { SqliteTaskRepository } from '../src/repositories/sqlite.js';
import { McpOAuthManager } from '../src/services/mcp-oauth.js';
import { mcpClientManager } from '../src/services/mcp-client.js';

/**
 * Deterministic MCP OAuth regression tests against a LOCAL OAuth test provider.
 * Implements RFC 9728 protected-resource metadata, RFC 8414 AS metadata, RFC 7591 dynamic
 * client registration, Authorization Code + PKCE (S256), token exchange + refresh, and an
 * MCP resource that requires the Bearer token. No external service or real credentials.
 */

const KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

function s256(v: string): string {
  return createHash('sha256').update(v).digest('base64url');
}

async function readBody(req: any): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

interface LocalProvider {
  base: string;
  mcpUrl: string;
  close: () => Promise<void>;
  expireAccessTokens: () => void;
  validAccess: Map<string, number>;
}

async function startLocalProvider(): Promise<LocalProvider> {
  const codes = new Map<string, { challenge: string; redirectUri: string }>();
  const refresh = new Map<string, boolean>();
  const validAccess = new Map<string, number>();
  const sessions = new Map<string, StreamableHTTPServerTransport>();

  const newSessionTransport = async (): Promise<StreamableHTTPServerTransport> => {
    const t = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => { sessions.set(id, t); },
    });
    const s = new McpServer({ name: 'oauth-resource', version: '0.0.0' });
    s.registerTool('ping', { description: 'ping' }, async () => ({ content: [{ type: 'text', text: 'pong' }] }));
    await s.connect(t);
    return t;
  };

  let base = '';
  const http: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', base);
    const json = (obj: unknown, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };

    if (url.pathname === '/.well-known/oauth-protected-resource') {
      return json({ resource: `${base}/mcp`, authorization_servers: [base], scopes_supported: ['openid', 'profile'] });
    }
    if (url.pathname === '/.well-known/oauth-authorization-server') {
      return json({
        issuer: base,
        authorization_endpoint: `${base}/oauth/authorize`,
        token_endpoint: `${base}/oauth/token`,
        registration_endpoint: `${base}/oauth/clients/register`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none'],
        scopes_supported: ['openid', 'profile', 'offline_access'],
      });
    }
    if (url.pathname === '/oauth/clients/register' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req));
      return json({ client_id: 'test-client-id', client_id_issued_at: Math.floor(Date.now() / 1000), redirect_uris: body.redirect_uris, token_endpoint_auth_method: 'none' }, 201);
    }
    if (url.pathname === '/oauth/authorize') {
      const p = url.searchParams;
      const code = `code-${randomUUID()}`;
      codes.set(code, { challenge: p.get('code_challenge') ?? '', redirectUri: p.get('redirect_uri') ?? '' });
      // Simulate the user approving in the browser: redirect back with code + state.
      res.writeHead(302, { Location: `${p.get('redirect_uri')}?code=${encodeURIComponent(code)}&state=${encodeURIComponent(p.get('state') ?? '')}` });
      return res.end();
    }
    if (url.pathname === '/oauth/token' && req.method === 'POST') {
      const body = new URLSearchParams(await readBody(req));
      const grant = body.get('grant_type');
      const issue = () => {
        const access = `access-${randomUUID()}`;
        const rt = `refresh-${randomUUID()}`;
        validAccess.set(access, Date.now() + 3600_000); refresh.set(rt, true);
        return json({ access_token: access, token_type: 'Bearer', expires_in: 3600, refresh_token: rt, scope: body.get('scope') ?? 'openid profile' });
      };
      if (grant === 'authorization_code') {
        const rec = codes.get(body.get('code') ?? '');
        if (!rec) return json({ error: 'invalid_grant' }, 400);
        if (s256(body.get('code_verifier') ?? '') !== rec.challenge) return json({ error: 'invalid_grant', error_description: 'PKCE mismatch' }, 400);
        codes.delete(body.get('code')!);
        return issue();
      }
      if (grant === 'refresh_token') {
        if (!refresh.has(body.get('refresh_token') ?? '')) return json({ error: 'invalid_grant' }, 400);
        return issue();
      }
      return json({ error: 'unsupported_grant_type' }, 400);
    }
    if (url.pathname === '/mcp') {
      const auth = req.headers.authorization ?? '';
      const token = auth.replace(/^Bearer /, '');
      const exp = validAccess.get(token);
      if (!exp || exp < Date.now()) {
        res.writeHead(401, { 'content-type': 'application/json', 'WWW-Authenticate': `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource"` });
        return res.end(JSON.stringify({ error: 'not_authenticated' }));
      }
      const sid = req.headers['mcp-session-id'] as string | undefined;
      const t = (sid && sessions.get(sid)) || await newSessionTransport();
      return t.handleRequest(req, res);
    }
    res.writeHead(404); res.end();
  });
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  const addr = http.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  base = `http://127.0.0.1:${port}`;
  return {
    base,
    mcpUrl: `${base}/mcp`,
    validAccess,
    expireAccessTokens: () => { for (const k of validAccess.keys()) validAccess.set(k, 0); },
    close: () => new Promise<void>((resolve) => http.close(() => resolve())),
  };
}

function makeRepo() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys=ON');
  migrateSqliteDatabase(db);
  return { db, repo: new SqliteTaskRepository(db) };
}

test('OAuth discovery + browser authorization + callback yields an authenticated MCP connection', async () => {
  process.env.MCP_ENCRYPTION_KEY = KEY;
  const provider = await startLocalProvider();
  const { db, repo } = makeRepo();
  const manager = new McpOAuthManager(repo);
  const id = 'mcp-server:oauth-flow';
  try {
    await repo.createServer({ id, name: 'oauth-flow', transport: 'streamable-http', url: provider.mcpUrl, args: [], env: {}, headers: {}, status: 'disconnected' } as any);

    const start = await manager.start(id, provider.mcpUrl);
    assert.equal(start.status, 'pending', 'first start requires browser authorization');
    assert.ok(start.authorizationUrl, 'authorization URL returned');
    assert.ok(start.authorizationUrl!.includes('code_challenge='), 'PKCE challenge present');
    assert.ok(start.authorizationUrl!.includes('state='), 'state present');

    // Simulate the browser visiting the authorization URL (auto-approve -> callback).
    const resp = await fetch(start.authorizationUrl!, { redirect: 'follow' });
    assert.equal(resp.status, 200);

    const status = await manager.status(id);
    assert.equal(status.status, 'authorized', 'callback exchanged the code and authorized');
    assert.equal(mcpClientManager.isConnected(id), true, 'MCP reconnected after authorization');
    const tools = await mcpClientManager.discoverTools(id);
    assert.ok(tools.some((t) => t.name === 'ping'), 'tools usable over the authenticated connection');

    // Tokens persisted encrypted (not plaintext).
    const raw = await repo.getOAuthData(id);
    assert.ok(raw, 'OAuth state persisted');
    assert.ok(!raw!.includes('access-'), 'access token not stored in plaintext');
  } finally {
    await mcpClientManager.disconnect(id);
    await manager.shutdown();
    await provider.close();
    db.close();
    delete process.env.MCP_ENCRYPTION_KEY;
  }
});

test('invalid callback state is rejected', async () => {
  process.env.MCP_ENCRYPTION_KEY = KEY;
  const provider = await startLocalProvider();
  const { db, repo } = makeRepo();
  const manager = new McpOAuthManager(repo);
  const id = 'mcp-server:oauth-badstate';
  try {
    await repo.createServer({ id, name: 'badstate', transport: 'streamable-http', url: provider.mcpUrl, args: [], env: {}, headers: {}, status: 'disconnected' } as any);
    const start = await manager.start(id, provider.mcpUrl);
    assert.equal(start.status, 'pending');
    // Hit the callback with a forged state (derive callback origin from the authorization redirect_uri).
    const authUrl = new URL(start.authorizationUrl!);
    const redirectUri = authUrl.searchParams.get('redirect_uri')!;
    const cb = new URL(redirectUri);
    const bad = await fetch(`${cb.origin}/oauth/callback?code=whatever&state=forged-state`);
    assert.equal(bad.status, 400, 'forged state rejected');
    assert.equal((await manager.status(id)).status, 'pending', 'not authorized by forged callback');
  } finally {
    await manager.shutdown();
    await provider.close();
    db.close();
    delete process.env.MCP_ENCRYPTION_KEY;
  }
});

test('token refresh reconnects after access token expiry; revoke clears authorization', async () => {
  process.env.MCP_ENCRYPTION_KEY = KEY;
  const provider = await startLocalProvider();
  const { db, repo } = makeRepo();
  const manager = new McpOAuthManager(repo);
  const id = 'mcp-server:oauth-refresh';
  try {
    await repo.createServer({ id, name: 'refresh', transport: 'streamable-http', url: provider.mcpUrl, args: [], env: {}, headers: {}, status: 'disconnected' } as any);
    const start = await manager.start(id, provider.mcpUrl);
    await fetch(start.authorizationUrl!, { redirect: 'follow' });
    assert.equal((await manager.status(id)).status, 'authorized');

    // Expire access tokens; reconnect should refresh via the refresh token.
    provider.expireAccessTokens();
    await mcpClientManager.disconnect(id);
    await manager.reconnect(id);
    assert.equal(mcpClientManager.isConnected(id), true, 'refresh restored the connection');

    // Revoke clears stored authorization and disconnects.
    await manager.revoke(id);
    assert.equal((await manager.status(id)).status, 'none');
    assert.equal(await repo.getOAuthData(id), undefined);
    assert.equal(mcpClientManager.isConnected(id), false);
  } finally {
    await mcpClientManager.disconnect(id);
    await manager.shutdown();
    await provider.close();
    db.close();
    delete process.env.MCP_ENCRYPTION_KEY;
  }
});

test('manual-header connection still works without OAuth', async () => {
  const provider = await startLocalProvider();
  const { db, repo } = makeRepo();
  const id = 'mcp-server:manual';
  try {
    // Mint a valid access token directly and use it as a manual header.
    const token = `manual-${randomUUID()}`;
    provider.validAccess.set(token, Date.now() + 3600_000);
    await repo.createServer({ id, name: 'manual', transport: 'streamable-http', url: provider.mcpUrl, args: [], env: {}, headers: { Authorization: `Bearer ${token}` }, status: 'disconnected' } as any);
    await mcpClientManager.connect({ id, name: 'manual', transport: 'streamable-http', url: provider.mcpUrl, headers: { Authorization: `Bearer ${token}` } });
    assert.equal(mcpClientManager.isConnected(id), true, 'manual header auth preserved');
  } finally {
    await mcpClientManager.disconnect(id);
    await provider.close();
    db.close();
  }
});
