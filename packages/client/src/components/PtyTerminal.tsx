import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { api } from '@/lib/api';

interface PtyTerminalProps {
  sessionId: string;
}

export function PtyTerminal({ sessionId }: PtyTerminalProps) {
  const termRef = useRef<HTMLDivElement>(null);
  const termInstanceRef = useRef<Terminal | null>(null);
  const [error, setError] = useState<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    const term = new Terminal({
      cursorBlink: true,
      cursorStyle: 'block',
      fontSize: 14,
      fontFamily: 'monospace',
      theme: {
        background: '#0f172a',
        foreground: '#e2e8f0',
      },
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);

    termRef.current && term.open(termRef.current);
    fitAddon.fit();

    termInstanceRef.current = term;

    // Connect WebSocket
    const wsUrl = `ws://${window.location.host}/ws/pty/${sessionId}`;
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      setError(null);
    };

    ws.onmessage = (event) => {
      const data = event.data;
      if (typeof data === 'string') {
        try {
          const msg = JSON.parse(data);
          if (msg.type === 'exit') {
            term.write(`\r\n\x1b[31mSession exited with code ${msg.exitCode}\x1b[0m\r\n`);
          } else if (msg.type === 'error') {
            setError(msg.error || 'PTY error');
          } else {
            term.write(msg.data || data);
          }
        } catch {
          term.write(data);
        }
      } else {
        term.write(data as unknown as string);
      }
    };

    ws.onclose = () => {
      termInstanceRef.current?.dispose();
      termInstanceRef.current = null;
    };

    ws.onerror = (err) => {
      setError('WebSocket error');
      console.error('PTY WebSocket error:', err);
    };

    // Handle terminal input
    term.onData((data: string) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(data);
      }
    });

    // Handle window resize
    const handleResize = () => {
      fitAddon.fit();
      if (ws.readyState === WebSocket.OPEN) {
        const cols = term.cols;
        const rows = term.rows;
        api.resizePtySession(sessionId, cols, rows).catch(() => {});
      }
    };

    window.addEventListener('resize', handleResize);

    return () => {
      window.removeEventListener('resize', handleResize);
      ws.close();
      term.dispose();
    };
  }, [sessionId]);

  if (error) {
    return (
      <div className="p-4 text-red-500 bg-red-500/10 rounded border border-red-500/20">
        <span>Terminal error: {error}</span>
      </div>
    );
  }

  return (
    <div className="relative w-full h-full bg-black text-white font-mono text-sm">
      <div ref={termRef} className="absolute inset-0" />
    </div>
  );
}
