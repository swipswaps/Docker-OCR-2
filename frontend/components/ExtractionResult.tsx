import React, { useState } from 'react';
import { Copy, Check, Download, Type, Code } from 'lucide-react';
import { ExtractionMode } from '../types';

interface ExtractionResultProps {
  text: string;
  onChange: (text: string) => void;
  mode: ExtractionMode;
}

export const ExtractionResult: React.FC<ExtractionResultProps> = ({ text, onChange, mode }) => {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleDownload = () => {
    const element = document.createElement("a");
    const extension = mode === 'json' ? 'json' : 'md';
    const mimeType = mode === 'json' ? 'application/json' : 'text/markdown';
    const file = new Blob([text], {type: mimeType});
    element.href = URL.createObjectURL(file);
    element.download = `extracted_document.${extension}`;
    document.body.appendChild(element);
    element.click();
    document.body.removeChild(element);
  };

  return (
    <div className="flex flex-col h-full bg-slate-800 rounded-xl overflow-hidden border border-slate-700 shadow-xl">
      <div className="flex items-center justify-between p-3 border-b border-slate-700 bg-slate-900/50">
        <div className="flex items-center space-x-2">
            {mode === 'json' ? <Code size={16} className="text-yellow-400"/> : <Type size={16} className="text-blue-400"/>}
            <span className="text-xs font-medium text-slate-400 uppercase tracking-wider">
              {mode === 'json' ? 'Structured JSON' : 'Layout Preservation'}
            </span>
        </div>
        <div className="flex space-x-1">
          <button 
            onClick={handleCopy}
            className="flex items-center space-x-1 px-3 py-1.5 bg-slate-700 hover:bg-slate-600 text-slate-300 rounded-md text-xs font-medium transition-colors"
          >
            {copied ? <Check size={14} className="text-green-400" /> : <Copy size={14} />}
            <span>{copied ? 'Copied' : 'Copy'}</span>
          </button>
          <button 
            onClick={handleDownload}
            className="p-1.5 hover:bg-slate-700 text-slate-400 hover:text-blue-400 rounded-md transition-colors"
            title={`Download as ${mode.toUpperCase()}`}
          >
            <Download size={16} />
          </button>
        </div>
      </div>
      <div className="flex-1 relative">
        <textarea
          value={text}
          onChange={(e) => onChange(e.target.value)}
          className={`w-full h-full bg-slate-900/30 p-4 text-slate-300 font-mono text-base leading-relaxed resize-none focus:outline-none focus:ring-2 focus:ring-blue-500/20 border-none ${mode === 'json' ? 'text-yellow-100/80' : ''}`}
          spellCheck={false}
          placeholder={mode === 'json' ? "{\n  \"status\": \"waiting for document...\"\n}" : "Extracted text will appear here..."}
        />
      </div>
    </div>
  );
};