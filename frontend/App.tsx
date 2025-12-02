import React, { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import { FileText, WifiOff, RefreshCw, Cpu, Server, X, Copy, Download, Settings } from 'lucide-react';
import { FileUpload } from './components/FileUpload';
import { DocumentViewer } from './components/DocumentViewer';
import { ExtractionResult } from './components/ExtractionResult';
import { Terminal } from './components/Terminal';
import { checkDockerHealth, processDocumentWithDocker, processDocumentWithTesseract, preprocessImage, rotateDocument, runDiagnostics } from './services/geminiService';
import { getInstallerScript } from './utils/backendScript';
import { LogEntry, ProcessingState, ExtractionMode, DockerHealth, OcrEngine } from './types';

type OutputTab = 'text' | 'json' | 'csv' | 'xlsx' | 'sql';

const App: React.FC = () => {
  const [file, setFile] = useState<File | null>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const [extractedText, setExtractedText] = useState<string>('');
  const [extractionMode, setExtractionMode] = useState<ExtractionMode>('layout');
  const [status, setStatus] = useState<ProcessingState>({ isProcessing: false, progressMessage: '' });

  // Docker Health State
  const [dockerHealth, setDockerHealth] = useState<DockerHealth>({ status: 'checking' });
  // Default to docker to encourage backend use
  const [activeEngine, setActiveEngine] = useState<OcrEngine>('docker');
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [showSetup, setShowSetup] = useState(false);
  const [activeOutputTab, setActiveOutputTab] = useState<OutputTab>('text');
  const [ocrBlocks, setOcrBlocks] = useState<any[]>([]);
  const [ocrTable, setOcrTable] = useState<any[]>([]);
  const [ocrColumns, setOcrColumns] = useState<number>(0);

  const addLog = useCallback((message: string, level: LogEntry['level'] = 'info') => {
    const timestamp = new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
    setLogs(prev => {
      // Limit log history to prevent memory leak
      const newLogs = [...prev, { timestamp, level, message }];
      return newLogs.length > 500 ? newLogs.slice(-500) : newLogs;
    });
  }, []);

  // Poll Docker Health - Use functional state updates to avoid stale closures
  // Don't switch engines during active processing (backend may be busy)
  const runHealthCheck = useCallback(async () => {
      const isHealthy = await checkDockerHealth();

      setDockerHealth(prevHealth => {
        if (isHealthy && prevHealth.status !== 'healthy') {
          addLog('Connected to PaddleOCR Docker Container', 'success');
          setActiveEngine('docker');
          return { status: 'healthy' };
        } else if (!isHealthy && prevHealth.status !== 'unhealthy') {
          // Only log warning if we're not already processing (backend might be busy with OCR)
          if (!status.isProcessing) {
            addLog('Docker unavailable. Offline mode active (Tesseract).', 'warn');
            setActiveEngine('tesseract');
          }
          return { status: 'unhealthy' };
        }
        return prevHealth;
      });
  }, [addLog, status.isProcessing]);

  useEffect(() => {
    let isMounted = true;

    const doHealthCheck = async () => {
      if (!isMounted) return;
      await runHealthCheck();
    };

    doHealthCheck(); // Initial check immediately

    // Use longer polling interval (15s) to reduce log spam when disconnected
    const interval = setInterval(doHealthCheck, 15000);

    return () => {
      isMounted = false;
      clearInterval(interval);
    };
  }, [runHealthCheck]);

  // Initial System Check Log
  useEffect(() => {
    addLog('System initialized. Environment: Browser Client', 'info');
    addLog('Checking for local OCR engine...', 'info');
  }, [addLog]);

  const processFile = async (currentFile: File, mode: ExtractionMode) => {
    setStatus({ isProcessing: true, progressMessage: `Processing with ${activeEngine === 'docker' ? 'PaddleOCR' : 'Tesseract'}...` });
    setExtractedText('');
    setOcrBlocks([]);
    setOcrTable([]);
    setOcrColumns(0);
    addLog(`Starting processing for ${currentFile.name} (${mode} mode) via ${activeEngine}`, 'info');

    try {
      const startTime = performance.now();
      let result;

      if (activeEngine === 'docker') {
         result = await processDocumentWithDocker(currentFile, mode, addLog);
      } else {
         result = await processDocumentWithTesseract(currentFile, mode, addLog);
      }

      const endTime = performance.now();

      setExtractedText(result.text);
      if (result.blocks) {
        setOcrBlocks(result.blocks);
      }
      if (result.table) {
        setOcrTable(result.table);
        addLog(`Detected table with ${result.table.length} rows and ${result.columns || 0} columns`, 'info');
      }
      if (result.columns) {
        setOcrColumns(result.columns);
      }
      addLog(`Processing complete in ${((endTime - startTime) / 1000).toFixed(2)}s`, 'success');
      if (result.confidence) {
          addLog(`Average Confidence: ${(result.confidence * 100).toFixed(1)}%`, 'info');
      }
      setStatus({ isProcessing: false, progressMessage: '' });
    } catch (error: any) {
      console.error(error);
      const msg = error.message || "Unknown error";
      addLog(`Extraction failed: ${msg}`, 'error');
      setStatus({ isProcessing: false, progressMessage: '' });
      setExtractedText(`Error processing document. Check terminal for details.`);
    }
  };

  const handleFileSelect = async (selectedFile: File) => {
    // Clean up previous object URL to prevent memory leak
    if (imagePreview) {
      URL.revokeObjectURL(imagePreview);
    }

    setFile(selectedFile);
    const previewUrl = URL.createObjectURL(selectedFile);
    setImagePreview(previewUrl);
    setExtractedText('');

    setStatus({ isProcessing: true, progressMessage: 'Preprocessing image...' });
    try {
        // Step 1: Preprocess (EXIF rotation + HEIC conversion)
        let processed = await preprocessImage(selectedFile, activeEngine, addLog);

        // Step 2: For Docker engine, skip OSD detection
        // EXIF rotation is already applied in preprocessImage, and PaddleOCR handles text orientation internally.
        // OSD detection was causing issues where it incorrectly detected already-corrected images as needing rotation.
        if (activeEngine === 'docker') {
          addLog('Docker engine: EXIF rotation applied. Skipping OSD (PaddleOCR handles orientation).', 'info');
        }

        setFile(processed);
        // Revoke old URL and create new one for processed image
        URL.revokeObjectURL(previewUrl);
        setImagePreview(URL.createObjectURL(processed));
        await processFile(processed, extractionMode);
    } catch (e: any) {
        addLog(`Preprocessing failed: ${e.message}`, 'error');
        setStatus({ isProcessing: false, progressMessage: '' });
        await processFile(selectedFile, extractionMode);
    }
  };

  const handleRotate = async (direction: 'left' | 'right') => {
      if (!file) return;
      const angle = direction === 'left' ? -90 : 90;
      addLog(`Manual rotation ${angle}°`, 'info');
      try {
          setStatus({ isProcessing: true, progressMessage: 'Rotating...' });
          const rotated = await rotateDocument(file, angle);
          setFile(rotated);
          // Clean up previous URL and create new one
          if (imagePreview) {
            URL.revokeObjectURL(imagePreview);
          }
          setImagePreview(URL.createObjectURL(rotated));
          await processFile(rotated, extractionMode);
      } catch(e: any) {
          addLog(`Rotation failed: ${e.message}`, 'error');
          setStatus({ isProcessing: false, progressMessage: '' });
      }
  };

  const handleRunDiagnostics = () => {
      runDiagnostics(addLog);
  };

  const handleDownloadInstaller = () => {
    const script = getInstallerScript();
    const blob = new Blob([script], { type: 'text/x-sh' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'setup_ocr.sh';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    addLog('Installer script downloaded (setup_ocr.sh)', 'success');
  };

  const handleModeChange = (mode: ExtractionMode) => {
      setExtractionMode(mode);
      if (file) {
          processFile(file, mode);
      }
  };

  // Convert OCR table to different formats
  const jsonOutput = useMemo(() => {
    if (!ocrTable.length) return JSON.stringify({ text: extractedText }, null, 2);
    return JSON.stringify(ocrTable.map(row => row.cells), null, 2);
  }, [ocrTable, extractedText]);

  const csvOutput = useMemo(() => {
    if (!ocrTable.length) return `"text"\n"${extractedText.replace(/"/g, '""')}"`;
    const rows = ocrTable.map(row =>
      row.cells.map((cell: string) => `"${(cell || '').replace(/"/g, '""')}"`).join(',')
    );
    return rows.join('\n');
  }, [ocrTable, extractedText]);

  const sqlOutput = useMemo(() => {
    const tableName = 'ocr_results';
    // Generate column names (col_a, col_b, etc.)
    const colCount = ocrColumns || 1;
    const colNames = Array.from({ length: colCount }, (_, i) => `col_${String.fromCharCode(97 + i)}`);
    const colDefs = colNames.map(c => `  ${c} TEXT`).join(',\n');
    const createTable = `-- Create table\nCREATE TABLE IF NOT EXISTS ${tableName} (\n  id SERIAL PRIMARY KEY,\n${colDefs}\n);\n\n-- Insert data\n`;

    if (!ocrTable.length) {
      const escaped = extractedText.replace(/'/g, "''");
      return createTable + `INSERT INTO ${tableName} (col_a) VALUES ('${escaped}');`;
    }

    const inserts = ocrTable.map(row => {
      const values = row.cells.map((cell: string) => `'${(cell || '').replace(/'/g, "''")}'`).join(', ');
      return `INSERT INTO ${tableName} (${colNames.join(', ')}) VALUES (${values});`;
    });
    return createTable + inserts.join('\n');
  }, [ocrTable, ocrColumns, extractedText]);

  const handleDownload = (content: string, filename: string, type: string) => {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    addLog(`Downloaded ${filename}`, 'success');
  };

  const handleDownloadXLSX = async () => {
    try {
      // Dynamic import for xlsx library
      const XLSX = await import('xlsx');
      let data: any[];

      if (ocrTable.length) {
        // Use table structure - each row.cells becomes a row in Excel
        data = ocrTable.map(row => {
          const rowObj: Record<string, string> = {};
          row.cells.forEach((cell: string, i: number) => {
            rowObj[String.fromCharCode(65 + i)] = cell || '';
          });
          return rowObj;
        });
      } else {
        data = [{ A: extractedText }];
      }

      const ws = XLSX.utils.json_to_sheet(data);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'OCR Results');
      XLSX.writeFile(wb, 'ocr_results.xlsx');
      addLog('Downloaded ocr_results.xlsx', 'success');
    } catch (e: any) {
      addLog(`XLSX export failed: ${e.message}`, 'error');
    }
  };

  return (
    <div className="flex flex-col h-screen bg-slate-900 text-slate-200 font-sans selection:bg-blue-500/30">
      <header className="flex items-center justify-between px-6 py-3 bg-slate-950 border-b border-slate-800 shadow-md z-20">
        <div className="flex items-center space-x-3">
          <div className="p-2 bg-blue-600 rounded-lg shadow-lg shadow-blue-900/20">
            <FileText size={24} className="text-white" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-white tracking-tight">DockerOCR</h1>
            <div className="flex items-center space-x-2 text-xs text-slate-500 font-medium">
                <span>{activeEngine === 'docker' ? 'LOCAL ENGINE' : 'OFFLINE MODE (BROWSER)'}</span>
            </div>
          </div>
        </div>

        <div className="flex items-center space-x-3">
           <button
             onClick={() => setShowSetup(true)}
             className={`flex items-center space-x-2 px-3 py-1.5 rounded-full border transition-all duration-300 ${
               dockerHealth.status === 'healthy'
                 ? 'bg-green-500/10 border-green-500/20 text-green-400 hover:bg-green-500/20'
                 : 'bg-red-500/10 border-red-500/20 text-red-400 hover:bg-red-500/20 animate-pulse'
             }`}
             title="Click to open setup instructions"
           >
             {dockerHealth.status === 'healthy' ? <Cpu size={14} /> : <WifiOff size={14} />}
             <span className="text-xs font-bold tracking-wider">
               {dockerHealth.status === 'healthy' ? 'DOCKER ACTIVE' : 'SETUP BACKEND'}
             </span>
             <Settings size={12} className="opacity-60" />
           </button>
        </div>
      </header>

      <main className="flex-1 flex overflow-hidden">
        <div className="w-1/2 flex flex-col border-r border-slate-800 bg-slate-900/50 p-4 relative">
          {file && imagePreview ? (
            <DocumentViewer 
                imageSrc={imagePreview} 
                onClear={() => { setFile(null); setImagePreview(null); setExtractedText(''); }}
                onRotate={handleRotate}
                isProcessing={status.isProcessing}
            />
          ) : (
            <div className="flex-1 flex flex-col justify-center">
                <FileUpload onFileSelect={handleFileSelect} isProcessing={status.isProcessing} />
            </div>
          )}
          
          {status.isProcessing && (
            <div className="absolute bottom-8 left-1/2 -translate-x-1/2 bg-slate-800/90 backdrop-blur border border-slate-700 px-6 py-3 rounded-full shadow-2xl flex items-center space-x-3 z-30">
              <RefreshCw size={18} className="animate-spin text-blue-400" />
              <span className="text-sm font-medium text-blue-100">{status.progressMessage}</span>
            </div>
          )}
        </div>

        <div className="w-1/2 flex flex-col bg-slate-900">
            <div className="flex-1 p-4 overflow-hidden flex flex-col">
                {/* Tab Navigation */}
                <div className="border-b border-slate-700 mb-4">
                  <nav className="flex space-x-1" aria-label="Output tabs">
                    {(['text', 'json', 'csv', 'xlsx', 'sql'] as OutputTab[]).map((tab) => (
                      <button
                        key={tab}
                        onClick={() => setActiveOutputTab(tab)}
                        className={`px-4 py-2 text-sm font-medium rounded-t-lg transition-all ${
                          activeOutputTab === tab
                            ? 'bg-slate-800 text-blue-400 border-b-2 border-blue-400'
                            : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/50'
                        }`}
                      >
                        {tab === 'text' && '📄 Text'}
                        {tab === 'json' && '🔧 JSON'}
                        {tab === 'csv' && '📊 CSV'}
                        {tab === 'xlsx' && '📗 XLSX'}
                        {tab === 'sql' && '🗄️ SQL'}
                      </button>
                    ))}
                  </nav>
                </div>

                {/* Tab Content */}
                <div className="flex-1 overflow-hidden flex flex-col">
                  {activeOutputTab === 'text' && (
                    <div className="flex-1 flex flex-col overflow-hidden">
                      <div className="flex justify-between items-center mb-2">
                        <span className="text-xs text-slate-500">Extracted Text</span>
                        <button
                          onClick={() => handleDownload(extractedText, 'ocr_result.txt', 'text/plain')}
                          className="text-xs bg-slate-700 hover:bg-slate-600 text-slate-300 px-3 py-1 rounded flex items-center gap-1"
                        >
                          <Download size={12} /> Download .txt
                        </button>
                      </div>
                      <ExtractionResult text={extractedText} onChange={setExtractedText} mode={extractionMode} />
                    </div>
                  )}

                  {activeOutputTab === 'json' && (
                    <div className="flex-1 flex flex-col overflow-hidden">
                      <div className="flex justify-between items-center mb-2">
                        <span className="text-xs text-slate-500">JSON Output ({ocrBlocks.length} blocks)</span>
                        <button
                          onClick={() => handleDownload(jsonOutput, 'ocr_result.json', 'application/json')}
                          className="text-xs bg-purple-600 hover:bg-purple-500 text-white px-3 py-1 rounded flex items-center gap-1"
                        >
                          <Download size={12} /> Download .json
                        </button>
                      </div>
                      <textarea
                        value={jsonOutput}
                        readOnly
                        className="flex-1 w-full font-mono text-xs bg-slate-950 text-green-400 p-3 rounded border border-slate-700 focus:outline-none resize-none"
                      />
                    </div>
                  )}

                  {activeOutputTab === 'csv' && (
                    <div className="flex-1 flex flex-col overflow-hidden">
                      <div className="flex justify-between items-center mb-2">
                        <span className="text-xs text-slate-500">CSV Output</span>
                        <button
                          onClick={() => handleDownload(csvOutput, 'ocr_result.csv', 'text/csv')}
                          className="text-xs bg-green-600 hover:bg-green-500 text-white px-3 py-1 rounded flex items-center gap-1"
                        >
                          <Download size={12} /> Download .csv
                        </button>
                      </div>
                      <textarea
                        value={csvOutput}
                        readOnly
                        className="flex-1 w-full font-mono text-xs bg-slate-950 text-slate-300 p-3 rounded border border-slate-700 focus:outline-none resize-none"
                      />
                    </div>
                  )}

                  {activeOutputTab === 'xlsx' && (
                    <div className="flex-1 flex flex-col overflow-hidden">
                      <div className="flex justify-between items-center mb-2">
                        <span className="text-xs text-slate-500">
                          Excel Preview ({ocrTable.length} rows × {ocrColumns} columns)
                        </span>
                        <button
                          onClick={handleDownloadXLSX}
                          className="text-xs bg-emerald-600 hover:bg-emerald-500 text-white px-3 py-1 rounded flex items-center gap-1"
                        >
                          <Download size={12} /> Download .xlsx
                        </button>
                      </div>
                      <div className="flex-1 bg-white rounded border border-slate-300 overflow-auto">
                        <table className="text-xs border-collapse" style={{ fontFamily: 'Calibri, Arial, sans-serif' }}>
                          <thead className="sticky top-0 z-10">
                            <tr>
                              <th className="bg-slate-200 border border-slate-300 py-1.5 px-2 text-center text-slate-600 font-semibold w-8"></th>
                              {ocrColumns > 0 && Array.from({ length: ocrColumns }, (_, i) => (
                                <th key={i} className="bg-slate-200 border border-slate-300 py-1.5 px-2 text-center text-slate-600 font-semibold min-w-[120px]">
                                  {String.fromCharCode(65 + i)}
                                </th>
                              ))}
                              {ocrColumns === 0 && <th className="bg-slate-200 border border-slate-300 py-1.5 px-2 text-center text-slate-600 font-semibold">A</th>}
                            </tr>
                          </thead>
                          <tbody>
                            {ocrTable.length > 0 ? ocrTable.map((row, rowIdx) => (
                              <tr key={rowIdx} className="hover:bg-blue-50">
                                <td className="bg-slate-100 border border-slate-300 py-1 px-2 text-slate-500 text-center font-medium">{rowIdx + 1}</td>
                                {row.cells.map((cell: string, colIdx: number) => (
                                  <td key={colIdx} className="bg-white border border-slate-300 py-1 px-2 text-slate-800 whitespace-nowrap">
                                    {cell || ''}
                                  </td>
                                ))}
                              </tr>
                            )) : (
                              <tr>
                                <td className="bg-slate-100 border border-slate-300 py-1 px-2 text-slate-500 text-center">1</td>
                                <td className="bg-white border border-slate-300 py-1 px-2 text-slate-400 italic">No data - upload an image</td>
                              </tr>
                            )}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}

                  {activeOutputTab === 'sql' && (
                    <div className="flex-1 flex flex-col overflow-hidden">
                      <div className="flex justify-between items-center mb-2">
                        <span className="text-xs text-slate-500">SQL Statements</span>
                        <button
                          onClick={() => handleDownload(sqlOutput, 'ocr_result.sql', 'text/plain')}
                          className="text-xs bg-orange-600 hover:bg-orange-500 text-white px-3 py-1 rounded flex items-center gap-1"
                        >
                          <Download size={12} /> Download .sql
                        </button>
                      </div>
                      <textarea
                        value={sqlOutput}
                        readOnly
                        className="flex-1 w-full font-mono text-xs bg-slate-950 text-orange-300 p-3 rounded border border-slate-700 focus:outline-none resize-none"
                      />
                    </div>
                  )}
                </div>
            </div>
        </div>
      </main>

      <div className="h-[200px] flex-shrink-0">
        <Terminal logs={logs} health={dockerHealth} onDiagnostics={handleRunDiagnostics} />
      </div>

      {showSetup && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-slate-800 rounded-2xl border border-slate-700 shadow-2xl max-w-2xl w-full overflow-hidden flex flex-col max-h-[90vh]">
            <div className="p-6 border-b border-slate-700 flex justify-between items-start bg-slate-900/50">
              <div>
                <h2 className="text-xl font-bold text-white flex items-center gap-2">
                  <Server className="text-blue-400" />
                  Local Backend Setup
                </h2>
                <p className="text-slate-400 text-sm mt-1">Unlock high-accuracy OCR by running the backend locally.</p>
              </div>
              <button onClick={() => setShowSetup(false)} className="text-slate-500 hover:text-white transition-colors">
                <X size={24} />
              </button>
            </div>
            
            <div className="p-6 space-y-6 overflow-y-auto">
              <div className="bg-blue-500/10 border border-blue-500/20 rounded-xl p-4">
                <h3 className="text-blue-400 font-semibold mb-2 text-sm uppercase tracking-wider">Why Upgrade?</h3>
                <p className="text-slate-300 text-sm leading-relaxed">
                  The offline browser engine struggles with complex tables, faint headers, and dense layouts. 
                  PaddleOCR runs locally in Docker and provides backend-grade accuracy for free.
                </p>
              </div>

              <div className="space-y-4">
                <div className="flex items-start gap-4">
                    <div className="bg-slate-700 text-white w-8 h-8 rounded-full flex items-center justify-center font-bold flex-shrink-0">1</div>
                    <div className="flex-1">
                        <h4 className="text-white font-medium mb-1">Download Installer</h4>
                        <p className="text-slate-400 text-sm mb-3">Get the self-contained setup script (creates Dockerfile, app.py, etc).</p>
                        <button 
                            onClick={handleDownloadInstaller}
                            className="flex items-center space-x-2 bg-blue-600 hover:bg-blue-500 text-white px-4 py-2 rounded-lg font-medium transition-all shadow-lg hover:shadow-blue-500/25"
                        >
                            <Download size={18} />
                            <span>Download setup_ocr.sh</span>
                        </button>
                    </div>
                </div>

                <div className="flex items-start gap-4">
                    <div className="bg-slate-700 text-white w-8 h-8 rounded-full flex items-center justify-center font-bold flex-shrink-0">2</div>
                    <div className="flex-1">
                        <h4 className="text-white font-medium mb-1">Run Installer</h4>
                        <p className="text-slate-400 text-sm mb-2">Open your terminal in the project folder and run:</p>
                        <div className="bg-slate-950 rounded-lg p-3 font-mono text-sm text-green-400 border border-slate-800 flex justify-between items-center group">
                            <code>sh setup_ocr.sh</code>
                            <button 
                                onClick={() => navigator.clipboard.writeText('sh setup_ocr.sh')}
                                className="opacity-0 group-hover:opacity-100 p-1.5 hover:bg-slate-800 rounded text-slate-400 hover:text-white transition-all"
                                title="Copy"
                            >
                                <Copy size={14} />
                            </button>
                        </div>
                    </div>
                </div>
              </div>
            </div>
            
            <div className="p-4 bg-slate-950 border-t border-slate-800 text-center">
                <p className="text-xs text-slate-500">
                    Once the script finishes, the status indicator will turn <span className="text-green-400 font-bold">GREEN</span> automatically.
                </p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default App;
