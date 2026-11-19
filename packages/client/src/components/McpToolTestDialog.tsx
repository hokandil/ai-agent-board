import { AnimatePresence, motion } from 'framer-motion';
import { X } from 'lucide-react';
import type { MCPTool, MCPToolCallResult } from '@/types';
import { api } from '@/lib/api';
import { useState } from 'react';

interface Props {
  tool: MCPTool | null;
  serverId: string | null;
  onClose: () => void;
}

export function McpToolTestDialog({ tool, serverId, onClose }: Props) {
  const [useJson, setUseJson] = useState(false);
  const [testArgs, setTestArgs] = useState<Record<string, unknown>>({});
  const [testJson, setTestJson] = useState('{}');
  const [testResult, setTestResult] = useState<string | null>(null);
  const [testError, setTestError] = useState<string | null>(null);
  const [testRunning, setTestRunning] = useState(false);

  if (!tool || !serverId) return null;

  const schema = (tool.inputSchema ?? {}) as { properties?: Record<string, any>; required?: string[] };
  const props = schema.properties ?? {};
  const required = schema.required ?? [];

  const run = async () => {
    setTestError(null);
    setTestResult(null);
    let args: unknown;
    if (useJson) {
      try {
        args = JSON.parse(testJson || '{}');
      } catch (e) {
        setTestError('Invalid JSON: ' + (e instanceof Error ? e.message : String(e)));
        return;
      }
    } else {
      for (const key of required) {
        if (testArgs[key] === undefined || testArgs[key] === '' || testArgs[key] === null) {
          setTestError(`${key} is required`);
          return;
        }
      }
      args = { ...testArgs };
    }
    setTestRunning(true);
    try {
      const result: MCPToolCallResult = await api.testMcpTool(serverId, tool.name, args);
      if (result.isError) {
        setTestError(`Tool returned error: ${JSON.stringify(result.content)}`);
      } else {
        setTestResult(JSON.stringify(result.content, null, 2));
      }
    } catch (err: unknown) {
      setTestError(err instanceof Error ? err.message : 'Tool test failed');
    } finally {
      setTestRunning(false);
    }
  };

  return (
    <AnimatePresence>
      <motion.div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
        <div className="bg-background border rounded-lg shadow-lg w-full max-w-lg max-h-[80vh] overflow-auto p-6">
          <div className="flex items-center justify-between mb-4">
            <h3 className="font-semibold">Test Tool: {tool.name}</h3>
            <button onClick={onClose}><X className="h-4 w-4" /></button>
          </div>
          {tool.description && <p className="text-sm text-muted-foreground mb-4">{tool.description}</p>}
          <div className="mb-4 flex gap-2">
            <button onClick={() => setUseJson(false)} className={`px-2 py-1 text-xs rounded border ${!useJson ? 'bg-primary text-primary-foreground' : 'bg-muted'}`}>Form</button>
            <button onClick={() => setUseJson(true)} className={`px-2 py-1 text-xs rounded border ${useJson ? 'bg-primary text-primary-foreground' : 'bg-muted'}`}>JSON</button>
          </div>
          {useJson ? (
            <textarea className="w-full h-40 font-mono text-xs border rounded p-2" value={testJson} onChange={(e) => setTestJson(e.target.value)} />
          ) : (
            <div className="space-y-3">
              {Object.keys(props).map((key) => {
                const p = props[key] as any;
                const isReq = required.includes(key);
                if (p?.enum) {
                  return (
                    <div key={key}>
                      <label className="text-xs font-medium">{key}{isReq ? ' *' : ''}</label>
                      <select className="w-full border rounded p-1 text-sm" value={String(testArgs[key] ?? '')} onChange={(e) => setTestArgs((prev) => ({ ...prev, [key]: e.target.value }))}>
                        <option value="">-- select --</option>
                        {p.enum.map((v: any) => <option key={String(v)} value={String(v)}>{String(v)}</option>)}
                      </select>
                    </div>
                  );
                }
                if (p?.type === 'boolean') {
                  return (
                    <div key={key} className="flex items-center gap-2">
                      <input type="checkbox" checked={!!testArgs[key]} onChange={(e) => setTestArgs((prev) => ({ ...prev, [key]: e.target.checked }))} />
                      <label className="text-xs font-medium">{key}{isReq ? ' *' : ''}</label>
                    </div>
                  );
                }
                if (p?.type === 'number' || p?.type === 'integer') {
                  return (
                    <div key={key}>
                      <label className="text-xs font-medium">{key}{isReq ? ' *' : ''}</label>
                      <input type="number" className="w-full border rounded p-1 text-sm" value={testArgs[key] !== undefined ? String(testArgs[key]) : ''} onChange={(e) => setTestArgs((prev) => ({ ...prev, [key]: e.target.value === '' ? undefined : Number(e.target.value) }))} />
                    </div>
                  );
                }
                if (p?.type === 'array' || p?.type === 'object') {
                  return (
                    <div key={key}>
                      <label className="text-xs font-medium">{key}{isReq ? ' *' : ''} (JSON)</label>
                      <textarea className="w-full border rounded p-1 text-xs font-mono" rows={3} value={typeof testArgs[key] === 'string' ? testArgs[key] as string : (testArgs[key] !== undefined ? JSON.stringify(testArgs[key]) : '')} onChange={(e) => {
                        const v = e.target.value;
                        try { setTestArgs((prev) => ({ ...prev, [key]: v === '' ? undefined : JSON.parse(v) })); }
                        catch { setTestArgs((prev) => ({ ...prev, [key]: v })); }
                      }} />
                    </div>
                  );
                }
                return (
                  <div key={key}>
                    <label className="text-xs font-medium">{key}{isReq ? ' *' : ''}</label>
                    <input type="text" className="w-full border rounded p-1 text-sm" value={testArgs[key] !== undefined ? String(testArgs[key]) : ''} onChange={(e) => setTestArgs((prev) => ({ ...prev, [key]: e.target.value }))} />
                  </div>
                );
              })}
            </div>
          )}
          {testError && <div className="mt-3 text-sm text-red-500">{testError}</div>}
          {testResult && <pre className="mt-3 text-xs bg-muted p-2 rounded overflow-auto max-h-48">{testResult}</pre>}
          <div className="mt-4 flex justify-end gap-2">
            <button onClick={onClose} className="px-3 py-1.5 text-sm rounded border">Cancel</button>
            <button onClick={run} disabled={testRunning} className="px-3 py-1.5 text-sm rounded bg-primary text-primary-foreground disabled:opacity-50">
              {testRunning ? 'Running...' : 'Run'}
            </button>
          </div>
        </div>
      </motion.div>
    </AnimatePresence>
  );
}