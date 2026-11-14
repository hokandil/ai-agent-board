import { WebSocketServer, WebSocket } from 'ws';
import type { Server } from 'http';
import type { WSMessage } from './types.js';
import { isValidToken } from './middleware/auth.js';
import { isAllowedWebSocketRequest, parseList } from './network-policy.js';
import { ptySessionManager } from './services/pty-session.js';

interface AliveWebSocket extends WebSocket {
  isAlive: boolean;
}

let wss: WebSocketServer;

const ALLOWED_HOSTS = parseList(process.env.ALLOWED_HOSTS, 'localhost,127.0.0.1');
const ALLOWED_ORIGINS = parseList(
  process.env.ALLOWED_ORIGINS,
  'http://localhost:8081,http://localhost:4175,http://localhost:4176',
);

export function createWSS(server: Server): WebSocketServer {
  if (wss) throw new Error('WSS already initialized');
  wss = new WebSocketServer({ noServer: true });

  // Handle HTTP upgrade — check auth token before accepting
  server.on('upgrade', (req, socket, head) => {
    if (req.url?.startsWith('/ws')) {
      if (!isAllowedWebSocketRequest(req, ALLOWED_HOSTS, ALLOWED_ORIGINS)) {
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
        socket.destroy();
        return;
      }

      const url = new URL(req.url, `http://${req.headers.host}`);

      // PTY session WebSocket: /ws/pty/:sessionId
      if (url.pathname.startsWith('/ws/pty/')) {
        const sessionId = url.pathname.split('/').pop();
        if (!sessionId) {
          socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
          socket.destroy();
          return;
        }
        if (!ptySessionManager.hasSession(sessionId)) {
          socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
          socket.destroy();
          return;
        }

        // PTY sessions don't require auth token — they're ephemeral
        wss.handleUpgrade(req, socket, head, (ws) => {
          setupPtySocket(ws, sessionId);
        });
        return;
      }

      // Regular WebSocket connection requires auth token
      const token = url.searchParams.get('token') ?? undefined;
      if (!isValidToken(token)) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }

      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req);
      });
    }
  });

  wss.on('connection', (rawWs) => {
    const ws = rawWs as AliveWebSocket;
    ws.isAlive = true;
    console.log('[WS] client connected');
    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('close', () => console.log('[WS] client disconnected'));
    ws.on('error', (err) => console.error('[WS] error:', err.message));
  });

  // Heartbeat to detect stale connections
  const interval = setInterval(() => {
    wss.clients.forEach((rawWs) => {
      const ws = rawWs as AliveWebSocket;
      if (ws.isAlive === false) return ws.terminate();
      ws.isAlive = false;
      ws.ping();
    });
  }, 30_000);

  wss.on('close', () => clearInterval(interval));

  return wss;
}

/** Handle PTY session WebSocket connection. */
function setupPtySocket(ws: WebSocket, sessionId: string): void {
  const pty = ptySessionManager.getSessionInfo(sessionId);
  if (!pty) {
    ws.close(1011, 'Session not found');
    return;
  }

  // Forward client input to PTY
  ws.on('message', (data: string | Buffer) => {
    const text = data instanceof Buffer ? data.toString('utf8') : String(data);
    ptySessionManager.sendInput(sessionId, text);
  });

  // Forward PTY output to client
  const unsubscribe = ptySessionManager.subscribe(sessionId, (event) => {
    if (ws.readyState === WebSocket.OPEN) {
      if (event.type === 'data' && event.data) {
        ws.send(event.data);
      } else if (event.type === 'exit') {
        ws.send(JSON.stringify({ type: 'exit', exitCode: event.exitCode }));
        ws.close(1000, 'Session exited');
      } else if (event.type === 'error') {
        ws.send(JSON.stringify({ type: 'error', error: event.error }));
        ws.close(1011, 'Session error');
      }
    }
  });

  ws.on('close', () => {
    unsubscribe();
  });

  ws.on('error', () => {
    unsubscribe();
  });
}

export function broadcast(message: WSMessage): void {
  if (!wss) return;
  const data = JSON.stringify(message);
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(data);
    }
  });
}
