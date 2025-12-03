
import React, { useEffect, useRef, useState } from 'react';
import { Terminal as TerminalIcon, Activity, Copy, Check, Play } from 'lucide-react';
import { LogEntry, DockerHealth } from '../types';

interface TerminalProps {
  logs: LogEntry[];
  health: DockerHealth;
  onDiagnostics?: () => void;
}

export const Terminal: React.FC<TerminalProps> = ({ logs, health, onDiagnostics }) => {
  const endRef = useRef<HTMLDivElement>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs]);

  const getStatusColor = (status: DockerHealth['status']) => {
    switch (status) {
      case 'healthy': return 'text-green-400';
      case 'unhealthy': return 'text-red-400';
      default: return 'text-yellow-400';
    }
  };

  const handleCopyLogs = () => {
    const text = logs.map(l => `[${l.timestamp}] [${l.level.toUpperCase()}] ${l.message}`).join('\n');
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="flex flex-col h-full bg-slate-950 border-t border-slate-800 font-mono text-xs">
      <div className="flex items-center justify-between px-3 py-2 bg-slate-900 border-b border-slate-800 select-none">
        <div className="flex items-center space-x-2">
          <TerminalIcon size={14} className="text-slate-400" />
          <span className="font-semibold text-slate-300">SYSTEM LOGS</span>
        </div>

        <div className="flex items-center space-x-4">
            <div className="flex items-center space-x-2 bg-slate-800 px-2 py-1 rounded border border-slate-700">
            <Activity size={12} className={getStatusColor(health.status)} />
            <span className={`uppercase font-bold ${getStatusColor(health.status)}`}>
                {health.status === 'checking' ? 'CONNECTING...' : health.status.toUpperCase()}
            </span>
            </div>

            {onDiagnostics && (
                <button
                    onClick={onDiagnostics}
                    className="flex items-center space-x-1.5 px-2 py-1 hover:bg-slate-800 text-blue-400 hover:text-white rounded transition-colors"
                    title="Run Connectivity Tests"
                >
                    <Play size={12} />
                    <span>Run Diagnostics</span>
                </button>
            )}

            <button
                onClick={handleCopyLogs}
                className="flex items-center space-x-1.5 px-2 py-1 hover:bg-slate-800 text-slate-400 hover:text-white rounded transition-colors"
                title="Copy all logs to clipboard"
            >
                {copied ? <Check size={12} className="text-green-400" /> : <Copy size={12} />}
                <span>{copied ? 'Copied' : 'Copy'}</span>
            </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-3 space-y-1.5 scrollbar-thin scrollbar-thumb-slate-700 scrollbar-track-slate-900">
        {logs.length === 0 && (
          <div className="text-slate-600 italic">Waiting for system events...</div>
        )}

        {logs.map((log, idx) => (
          <div key={idx} className="flex space-x-3 hover:bg-slate-900/50 p-0.5 rounded group">
            <span className="text-slate-500 min-w-[70px] select-none">{log.timestamp}</span>
            <div className="flex-1 break-all">
              {log.level === 'info' && <span className="text-blue-400 mr-2 select-none">[INFO]</span>}
              {log.level === 'warn' && <span className="text-yellow-400 mr-2 select-none">[WARN]</span>}
              {log.level === 'error' && <span className="text-red-400 mr-2 select-none">[ERR]</span>}
              {log.level === 'success' && <span className="text-green-400 mr-2 select-none">[OK]</span>}
              <span className="text-slate-300 group-hover:text-white transition-colors">{log.message}</span>
            </div>
          </div>
        ))}
        <div ref={endRef} />
      </div>
    </div>
  );
};
