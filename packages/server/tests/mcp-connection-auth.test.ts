import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer, type Server as HttpServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp';
import { mcpClientManager } from '../src/services/mcp-client.js';

/**
 * Regression test — MCP credential delivery on connect.
 *
 * Proves the blocked "not_authenticated" path is correct end-to-end: a local MCP server
 * that REQUIRES an Authorization header is reachable by the Board only when the stored
 * credential (headers) is configured and sent on connect. No real external service or
 * hardcoded secret is used; the token here is a local test fixture.
 */

const TOKEN = 'local-test-token';

async function startAuthMcpServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const mcp = new McpServer({ name: 'auth-test', version: '0.0.0' });
  mcp.registerTool('ping', { description: 'ping' }, async () => ({
    content: [{ type: 'text', text: 'pong' }],
  }));
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
  await mcp.connect(transport);

  const http: HttpServer = createServer((req, res) => {
    const auth = req.headers.authorization;
    if (auth !== `Bearer ${TOKEN}`) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not_authenticated' }));
      return;
    }
    transport.handleRequest(req, res);
  });
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  const addr = http.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    close: () => new Promise<void>((resolve) => { http.close(() => resolve()); }),
  };
}

test('MCP connect succeeds when the stored Authorization credential is sent', async () => {
  const srv = await startAuthMcpServer();
  const id = 'mcp-server:auth-ok';
  try {
    await mcpClientManager.connect({
      id, name: 'auth-ok', transport: 'streamable-http', url: srv.url,
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(mcpClientManager.isConnected(id), true, 'connect must succeed with the credential');
    const tools = await mcpClientManager.discoverTools(id);
    assert.ok(tools.some((t) => t.name === 'ping'), 'tools discovered over authenticated connection');
  } finally {
    await mcpClientManager.disconnect(id);
    await srv.close();
  }
});

test('MCP connect fails (not_authenticated) when no credential is configured', async () => {
  const srv = await startAuthMcpServer();
  const id = 'mcp-server:auth-missing';
  try {
    await assert.rejects(
      mcpClientManager.connect({ id, name: 'auth-missing', transport: 'streamable-http', url: srv.url }),
      /not_authenticated|401|Unauthorized/i,
    );
    assert.equal(mcpClientManager.isConnected(id), false);
  } finally {
    await mcpClientManager.disconnect(id);
    await srv.close();
  }
});
