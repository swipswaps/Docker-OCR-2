/**
 * Receipts OCR App - Main Component
 * Based on Docker-OCR-2 patterns from llm_notes
 */
import { useState, useCallback, useRef, useEffect } from 'react';
import { Upload, FileText, Database, Trash2, Save, RefreshCw, CheckCircle, AlertCircle, Info, AlertTriangle } from 'lucide-react';
import type { OcrResponse, Receipt, LogEntry, BackendHealth, OcrEngine } from './types';
import {
  checkBackendHealth,
  preprocessImage,
  processWithDocker,
  processWithTesseract,
  listReceipts,
  saveReceipt,
  deleteReceipt
} from './services/ocrService';
import './App.css';

function App() {
  // State
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [ocrResult, setOcrResult] = useState<OcrResponse | null>(null);
  const [receipts, setReceipts] = useState<Receipt[]>([]);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [activeTab, setActiveTab] = useState<'upload' | 'history'>('upload');
  const [backendHealth, setBackendHealth] = useState<BackendHealth>({ status: 'checking' });
  const [ocrEngine, setOcrEngine] = useState<OcrEngine>('docker');

  const fileInputRef = useRef<HTMLInputElement>(null);

  // Logging helper
  const addLog = useCallback((message: string, level: LogEntry['level'] = 'info') => {
    setLogs(prev => [...prev, {
      timestamp: new Date().toLocaleTimeString(),
      level,
      message
    }]);
  }, []);

  // Check backend health on mount
  useEffect(() => {
    const checkHealth = async () => {
      const healthy = await checkBackendHealth();
      setBackendHealth({
        status: healthy ? 'healthy' : 'unhealthy',
        ocr_engine: healthy ? 'PaddleOCR' : undefined,
        database: healthy ? 'PostgreSQL' : undefined
      });
      if (!healthy) {
        addLog('Docker backend unavailable, using Tesseract.js fallback', 'warn');
        setOcrEngine('tesseract');
      } else {
        addLog('Docker backend connected (PaddleOCR + PostgreSQL)', 'success');
      }
    };
    checkHealth();
  }, [addLog]);

  // Load receipts function
  const loadReceipts = useCallback(async () => {
    try {
      const data = await listReceipts();
      setReceipts(data);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Unknown error';
      addLog(`Failed to load receipts: ${msg}`, 'error');
    }
  }, [addLog]);

  // Load receipts when switching to history tab
  useEffect(() => {
    if (activeTab === 'history' && backendHealth.status === 'healthy') {
      loadReceipts();
    }
  }, [activeTab, backendHealth.status, loadReceipts]);

  // File handling
  const handleFileSelect = useCallback(async (selectedFile: File) => {
    setFile(selectedFile);
    setOcrResult(null);
    setLogs([]);

    // Create preview
    const reader = new FileReader();
    reader.onload = (e) => setPreview(e.target?.result as string);

    // Preprocess (HEIC conversion, EXIF rotation)
    addLog(`Selected: ${selectedFile.name} (${(selectedFile.size / 1024).toFixed(1)} KB)`, 'info');
    const processed = await preprocessImage(selectedFile, addLog);

    reader.readAsDataURL(processed);
    setFile(processed);
  }, [addLog]);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    const droppedFile = e.dataTransfer.files[0];
    if (droppedFile) handleFileSelect(droppedFile);
  }, [handleFileSelect]);

  // OCR Processing
  const processReceipt = async () => {
    if (!file) return;

    setIsProcessing(true);
    setLogs([]);

    try {
      let result: OcrResponse;

      if (ocrEngine === 'docker' && backendHealth.status === 'healthy') {
        result = await processWithDocker(file, addLog);
      } else {
        result = await processWithTesseract(file, addLog);
      }

      setOcrResult(result);

      if (result.parsed) {
        const { items, total } = result.parsed;
        addLog(`Parsed: ${items.length} items, Total: $${total?.toFixed(2) || 'N/A'}`, 'success');
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Unknown error';
      addLog(`OCR failed: ${msg}`, 'error');
    } finally {
      setIsProcessing(false);
    }
  };

  // Save to database
  const handleSave = async () => {
    if (!ocrResult || !file) return;

    try {
      const { receipt_id } = await saveReceipt(
        file.name,
        ocrResult.parsed,
        ocrResult.raw_text
      );
      addLog(`Receipt saved to database (ID: ${receipt_id})`, 'success');
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Unknown error';
      addLog(`Save failed: ${msg}`, 'error');
    }
  };

  // Delete receipt
  const handleDelete = async (id: number) => {
    try {
      await deleteReceipt(id);
      setReceipts(prev => prev.filter(r => r.id !== id));
      addLog(`Receipt ${id} deleted`, 'success');
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Unknown error';
      addLog(`Delete failed: ${msg}`, 'error');
    }
  };

  const LogIcon = ({ level }: { level: LogEntry['level'] }) => {
    switch (level) {
      case 'success': return <CheckCircle className="log-icon success" size={14} />;
      case 'error': return <AlertCircle className="log-icon error" size={14} />;
      case 'warn': return <AlertTriangle className="log-icon warn" size={14} />;
      default: return <Info className="log-icon info" size={14} />;
    }
  };

  return (
    <div className="app">
      <header className="header">
        <h1><FileText size={28} /> Receipts OCR</h1>
        <div className="status">
          <span className={`status-dot ${backendHealth.status}`} />
          {backendHealth.status === 'healthy' ? 'PaddleOCR + PostgreSQL' : 'Tesseract.js (Offline)'}
        </div>
      </header>

      <nav className="tabs">
        <button
          className={activeTab === 'upload' ? 'active' : ''}
          onClick={() => setActiveTab('upload')}
        >
          <Upload size={16} /> Upload
        </button>
        <button
          className={activeTab === 'history' ? 'active' : ''}
          onClick={() => setActiveTab('history')}
          disabled={backendHealth.status !== 'healthy'}
        >
          <Database size={16} /> History
        </button>
      </nav>

      <main className="main">
        {activeTab === 'upload' ? (
          <div className="upload-view">
            {/* Drop Zone */}
            <div
              className="dropzone"
              onDrop={handleDrop}
              onDragOver={(e) => e.preventDefault()}
              onClick={() => fileInputRef.current?.click()}
            >
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*,.heic"
                onChange={(e) => e.target.files?.[0] && handleFileSelect(e.target.files[0])}
                hidden
              />
              {preview ? (
                <img src={preview} alt="Receipt preview" className="preview" />
              ) : (
                <div className="dropzone-placeholder">
                  <Upload size={48} />
                  <p>Drop receipt image or click to upload</p>
                  <small>Supports JPEG, PNG, HEIC</small>
                </div>
              )}
            </div>

            {/* Actions */}
            <div className="actions">
              <button
                className="btn primary"
                onClick={processReceipt}
                disabled={!file || isProcessing}
              >
                {isProcessing ? <RefreshCw className="spin" size={16} /> : <FileText size={16} />}
                {isProcessing ? 'Processing...' : 'Extract Text'}
              </button>

              {ocrResult && backendHealth.status === 'healthy' && (
                <button className="btn secondary" onClick={handleSave}>
                  <Save size={16} /> Save to Database
                </button>
              )}
            </div>

            {/* Logs */}
            {logs.length > 0 && (
              <div className="logs">
                {logs.map((log, i) => (
                  <div key={i} className={`log-entry ${log.level}`}>
                    <LogIcon level={log.level} />
                    <span className="log-time">{log.timestamp}</span>
                    <span className="log-msg">{log.message}</span>
                  </div>
                ))}
              </div>
            )}

            {/* Results */}
            {ocrResult && (
              <div className="results">
                <h3>Extracted Data</h3>

                {ocrResult.parsed.store_name && (
                  <div className="result-field">
                    <label>Store:</label>
                    <span>{ocrResult.parsed.store_name}</span>
                  </div>
                )}

                {ocrResult.parsed.items.length > 0 && (
                  <div className="items-table">
                    <table>
                      <thead>
                        <tr><th>Item</th><th>Qty</th><th>Price</th></tr>
                      </thead>
                      <tbody>
                        {ocrResult.parsed.items.map((item, i) => (
                          <tr key={i}>
                            <td>{item.name}</td>
                            <td>{item.quantity}</td>
                            <td>${item.total_price?.toFixed(2)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}

                <div className="totals">
                  {ocrResult.parsed.subtotal && (
                    <div className="result-field">
                      <label>Subtotal:</label>
                      <span>${ocrResult.parsed.subtotal.toFixed(2)}</span>
                    </div>
                  )}
                  {ocrResult.parsed.tax && (
                    <div className="result-field">
                      <label>Tax:</label>
                      <span>${ocrResult.parsed.tax.toFixed(2)}</span>
                    </div>
                  )}
                  {ocrResult.parsed.total && (
                    <div className="result-field total">
                      <label>Total:</label>
                      <span>${ocrResult.parsed.total.toFixed(2)}</span>
                    </div>
                  )}
                </div>

                <details className="raw-text">
                  <summary>Raw OCR Text</summary>
                  <pre>{ocrResult.raw_text}</pre>
                </details>
              </div>
            )}
          </div>
        ) : (
          <div className="history-view">
            <div className="history-header">
              <h2>Saved Receipts</h2>
              <button className="btn secondary" onClick={loadReceipts}>
                <RefreshCw size={16} /> Refresh
              </button>
            </div>

            {receipts.length === 0 ? (
              <p className="empty">No receipts saved yet</p>
            ) : (
              <div className="receipts-list">
                {receipts.map(receipt => (
                  <div key={receipt.id} className="receipt-card">
                    <div className="receipt-info">
                      <strong>{receipt.store_name || receipt.filename}</strong>
                      <small>{new Date(receipt.created_at).toLocaleDateString()}</small>
                    </div>
                    <div className="receipt-total">
                      ${receipt.total?.toFixed(2) || '—'}
                    </div>
                    <button
                      className="btn icon"
                      onClick={() => handleDelete(receipt.id)}
                      title="Delete"
                    >
                      <Trash2 size={16} />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </main>
    </div>
  );
}

export default App;
