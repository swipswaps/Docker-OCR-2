import { OCRResponse } from "../types";
// Use namespace import to handle both default and named exports safely
import * as TesseractModule from 'tesseract.js';
import * as exifr from 'exifr';
import heic2any from 'heic2any';

const API_BASE = "http://localhost:5000";

// Robustly get the createWorker function from the module or its default export
// @ts-ignore
const createWorker = TesseractModule.createWorker || TesseractModule.default?.createWorker;

/**
 * Polls the Docker container health endpoint.
 * Returns true if the backend is healthy and responding.
 */
export const checkDockerHealth = async (): Promise<boolean> => {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 3000);

    const response = await fetch(`${API_BASE}/health`, {
      signal: controller.signal,
      method: 'GET',
      headers: { 'Accept': 'application/json' },
      cache: 'no-store'
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      return false;
    }

    // Verify response body is valid JSON with healthy status
    try {
      const data = await response.json();
      return data.status === 'healthy';
    } catch {
      // Response wasn't valid JSON but HTTP was OK - still consider healthy
      return true;
    }
  } catch {
    // Network error, timeout, or CORS - backend is not reachable
    return false;
  }
};

/**
 * Diagnostic suite to help user debug connection issues.
 */
export const runDiagnostics = async (onLog: (msg: string, level: any) => void) => {
    onLog('Running System Diagnostics...', 'info');
    
    // 1. Check Fetch
    try {
        onLog(`[Step 1/4] Connecting to Backend (${API_BASE}/health)...`, 'info');
        const res = await fetch(`${API_BASE}/health`);
        onLog(`[Result] HTTP Status: ${res.status} ${res.statusText}`, res.ok ? 'success' : 'error');
        
        if (res.ok) {
            const text = await res.text();
            onLog(`[Result] Body: ${text}`, 'info');
        } else {
             onLog(`[Hint] A 500 error means the Python script crashed. A 404 means the route is wrong.`, 'warn');
        }
    } catch (e: any) {
        onLog(`[Result] Connection Failed: ${e.message}`, 'error');
        if (e.message.includes('Failed to fetch')) {
            onLog('[Hint] Ensure Docker container is running and port 5000 is mapped.', 'warn');
            onLog('[Hint] If running in CodeSandbox/StackBlitz, you cannot connect to localhost.', 'warn');
            onLog('[Hint] Check if your browser is blocking Mixed Content (HTTP vs HTTPS).', 'warn');
        }
    }

    // 2. Check CORS Preflight
    try {
        onLog(`[Step 2/4] Checking CORS (OPTIONS ${API_BASE}/ocr)...`, 'info');
        const res = await fetch(`${API_BASE}/ocr`, { method: 'OPTIONS' });
        onLog(`[Result] Preflight Status: ${res.status}`, res.ok ? 'success' : 'error');
        if (!res.ok) {
             onLog('[Hint] CORS is blocking requests. Update app.py with permissive CORS config.', 'error');
        }
    } catch (e: any) {
        onLog(`[Result] Preflight Failed: ${e.message}`, 'error');
    }

    // 3. Tesseract Check
    onLog('[Step 3/4] Verifying Browser Wasm Engine...', 'info');
    if (createWorker) {
        onLog('[Result] Tesseract.js Library Loaded', 'success');
    } else {
        onLog('[Result] Tesseract.js Library Missing or Invalid', 'error');
    }

    // 4. Canvas Support
    onLog('[Step 4/4] Checking Graphics Capabilities...', 'info');
    const canvas = document.createElement('canvas');
    if (canvas.getContext('2d')) {
         onLog('[Result] HTML5 Canvas: Supported', 'success');
    } else {
         onLog('[Result] HTML5 Canvas: Unsupported (Image processing will fail)', 'error');
    }
    
    onLog('Diagnostics Complete.', 'info');
};

const sanitizeLog = (message: string): string => {
    if (!message) return '';
    let clean = message;
    clean = clean.replace(/data:[a-zA-Z0-9\/]+;base64,[a-zA-Z0-9+/=]+/g, '[Base64 Data Omitted]');
    clean = clean.replace(/[a-zA-Z0-9+/=]{100,}/g, '[Long Base64 String Omitted]');
    if (clean.length > 1000) {
        clean = clean.substring(0, 1000) + '... [Truncated]';
    }
    return clean;
};

/**
 * Rotates an image file by specific angle using Canvas.
 */
const rotateImageCanvas = (file: File, angleDegrees: number): Promise<File> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        if (!ctx) return reject(new Error('Could not get canvas context'));

        const angle = (angleDegrees * Math.PI) / 180;
        const absAngle = Math.abs(angleDegrees);
        const isPerpendicular = Math.abs(absAngle - 90) < 0.1 || Math.abs(absAngle - 270) < 0.1;

        if (isPerpendicular) {
            canvas.width = img.height;
            canvas.height = img.width;
        } else {
            canvas.width = img.width;
            canvas.height = img.height;
        }

        ctx.save();
        ctx.translate(canvas.width / 2, canvas.height / 2);
        ctx.rotate(angle);
        ctx.drawImage(img, -img.width / 2, -img.height / 2);
        ctx.restore();
        
        canvas.toBlob((blob) => {
          if (blob) resolve(new File([blob], file.name, { type: 'image/jpeg' }));
          else reject(new Error('Canvas to Blob failed'));
        }, 'image/jpeg', 0.95);
      };
      img.src = e.target?.result as string;
    };
    reader.readAsDataURL(file);
  });
};

export const rotateDocument = async (file: File, degrees: number): Promise<File> => {
    return rotateImageCanvas(file, degrees);
};

const detectOrientationOSD = async (
  file: File,
  onLog?: (message: string, level?: 'info' | 'warn' | 'success' | 'error') => void
): Promise<number> => {
  let worker = null;
  try {
    // Robust Initialization: Standard 'eng' -> Load 'osd' -> Init 'osd'
    onLog?.('Initializing OSD Worker (eng + osd)...', 'info');
    worker = await createWorker('eng', 3, { logger: () => {} });
    await worker.loadLanguage('osd');
    await worker.initialize('osd'); 
    await worker.setParameters({ tessedit_pageseg_mode: '0' });
    
    const result = await worker.recognize(file);
    if (result && result.data) {
        onLog?.(`[Verbatim] OSD Output: Orientation ${result.data.orientation_degrees}°`, 'info');
        return result.data.orientation_degrees || 0;
    }
    return 0;
  } catch (e: any) {
    // Suppress the known RuntimeError in WASM to avoid panicking the user
    const msg = sanitizeLog(e.message || e.toString());
    if (msg.includes('Aborted') || msg.includes('RuntimeError')) {
        onLog?.('OSD Detection skipped (Wasm Runtime compatibility). Continuing.', 'warn');
        return 0; 
    }
    onLog?.(`OSD Detection failed: ${msg}`, 'warn'); 
    return 0;
  } finally {
    if (worker) await worker.terminate();
  }
};

const getImageDimensions = (file: File): Promise<{width: number, height: number}> => {
    return new Promise((resolve) => {
        const img = new Image();
        const objectUrl = URL.createObjectURL(file);

        img.onload = () => {
          URL.revokeObjectURL(objectUrl); // Prevent memory leak
          resolve({ width: img.width, height: img.height });
        };
        img.onerror = () => {
          URL.revokeObjectURL(objectUrl); // Prevent memory leak
          resolve({ width: 0, height: 0 });
        };
        img.src = objectUrl;
    });
};

/**
 * Enhances image quality for OCR (Tesseract Only).
 */
const enhanceAndPadImage = (file: File, resizeToWidth: number = 2500, applyDilation: boolean = true, onLog?: (msg: string, level: any) => void): Promise<File> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        if (!ctx) return reject(new Error('Could not get canvas context'));

        let width = img.width;
        let height = img.height;
        
        // Resize
        if (resizeToWidth && width > resizeToWidth) {
            const scale = resizeToWidth / width;
            width = Math.floor(width * scale);
            height = Math.floor(height * scale);
            onLog?.(`[Ported Logic] Resizing to 300DPI equivalent (${width}x${height})...`, 'info');
        }

        const padding = Math.floor(Math.max(width, height) * 0.1); 
        canvas.width = width + (padding * 2);
        canvas.height = height + (padding * 2);

        ctx.fillStyle = '#FFFFFF';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, padding, padding, width, height);

        // Grayscale (Simple Luma)
        onLog?.(`[Ported Logic] Applying Grayscale...`, 'info');
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const data = imageData.data;
        for (let i = 0; i < data.length; i += 4) {
            const gray = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
            data[i] = data[i + 1] = data[i + 2] = gray;
        }
        ctx.putImageData(imageData, 0, 0);

        // Dilation
        if (applyDilation) {
            onLog?.(`[Ported Logic] Applying Dilation (Thickening text)...`, 'info');
            ctx.globalCompositeOperation = 'darken';
            ctx.drawImage(ctx.canvas, 1, 0);
            ctx.drawImage(ctx.canvas, 0, 1);
            ctx.globalCompositeOperation = 'source-over';
        }
        
        canvas.toBlob((blob) => {
          if (blob) resolve(new File([blob], file.name, { type: 'image/jpeg' }));
          else reject(new Error('Canvas to Blob failed'));
        }, 'image/jpeg', 0.95);
      };
      img.src = e.target?.result as string;
    };
    reader.readAsDataURL(file);
  });
};

const addWhiteBorder = enhanceAndPadImage;

export const preprocessImage = async (
  file: File,
  engine: 'docker' | 'tesseract',
  onLog?: (message: string, level?: 'info' | 'warn' | 'success' | 'error') => void
): Promise<File> => {
  let processedFile = file;
  const originalFile = file;

  // 1. Convert HEIC
  if (file.name.toLowerCase().endsWith('.heic') || file.type === 'image/heic') {
    onLog?.('Detected HEIC image, converting to JPEG...', 'info');
    try {
      const blob = await heic2any({ blob: file, toType: 'image/jpeg', quality: 0.9 });
      const processedBlob = Array.isArray(blob) ? blob[0] : blob;
      processedFile = new File([processedBlob], file.name.replace(/\.heic$/i, '.jpg'), { type: 'image/jpeg' });
      const dims = await getImageDimensions(processedFile);
      onLog?.(`HEIC converted: ${dims.width}x${dims.height}`, 'success');
    } catch (e: any) {
      onLog?.(`HEIC conversion failed: ${e.message}`, 'error');
      console.error("HEIC conversion failed:", e);
    }
  }

  // 2. EXIF Rotation - Read from original file before any conversion
  let exifAngle = 0;
  try {
      const orientation = await exifr.orientation(originalFile);
      if (orientation) {
        onLog?.(`[Verbatim] EXIF Orientation tag: ${orientation}`, 'info');
        // Standard EXIF orientation values:
        // 1 = Normal (0°)
        // 3 = Rotated 180°
        // 6 = Rotated 90° CW (image needs 90° CW rotation to display correctly)
        // 8 = Rotated 270° CW / 90° CCW (image needs 270° CW rotation)
        switch (orientation) {
            case 3: exifAngle = 180; break;
            case 6: exifAngle = 90; break;
            case 8: exifAngle = 270; break;
        }
      }
  } catch (e: any) {
      onLog?.(`EXIF read skipped: ${e.message || 'unknown error'}`, 'warn');
  }

  if (exifAngle !== 0) {
      onLog?.(`Applying EXIF rotation correction (${exifAngle}°)...`, 'info');
      processedFile = await rotateImageCanvas(processedFile, exifAngle);
      onLog?.(`EXIF rotation applied successfully`, 'success');
  } else {
      onLog?.('No EXIF rotation needed', 'info');
  }

  // 3. Optimization Path for Docker
  if (engine === 'docker') {
      onLog?.('Engine: Docker. Skipping frontend enhancements to prevent backend conflicts.', 'info');
      return processedFile; 
  }

  // 4. Tesseract Path: OSD Check + Enhancements
  onLog?.('Stage 2: Checking visual orientation (OSD)...', 'info');
  const osdAngle = await detectOrientationOSD(processedFile, onLog);
  if (osdAngle !== 0) {
      const correctionAngle = 360 - osdAngle;
      if (correctionAngle !== 0 && correctionAngle !== 360) {
        onLog?.(`OSD Correction Needed. Rotating ${correctionAngle}°...`, 'info');
        processedFile = await rotateImageCanvas(processedFile, correctionAngle);
      }
  }

  try {
      onLog?.('Engine: Tesseract. Applying padding & enhancement...', 'info');
      processedFile = await addWhiteBorder(processedFile, 2500, true, onLog);
  } catch (e: any) {
      console.warn("Padding failed", e);
  }
  
  return processedFile;
};

export const processDocumentWithDocker = async (
  file: File,
  mode: 'layout' | 'json',
  onLog?: (message: string, level?: 'info' | 'warn' | 'success' | 'error') => void
): Promise<OCRResponse> => {
  const startTime = performance.now();

  // Log file details
  onLog?.(`Uploading ${file.name} (${(file.size/1024/1024).toFixed(2)}MB) to PaddleOCR...`, 'info');

  const formData = new FormData();
  formData.append('file', file);
  formData.append('mode', mode);

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 120000); // 120s timeout for CPU hosts

    const response = await fetch(`${API_BASE}/ocr`, {
      method: 'POST',
      body: formData,
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    const networkTime = ((performance.now() - startTime) / 1000).toFixed(2);

    if (!response.ok) {
      const errorData = await response.json().catch(() => null);
      // Display verbatim logs from error response
      if (errorData?.logs) {
        for (const log of errorData.logs) {
          const level = log.level === 'success' ? 'success' : log.level === 'error' ? 'error' : 'info';
          onLog?.(`[${log.timestamp}] ${log.message}`, level);
        }
      }
      throw new Error(`Server Error: ${response.status} - ${errorData?.error || 'Unknown error'}`);
    }

    const data = await response.json();
    if (!data) throw new Error("Empty response from backend");

    // Display verbatim backend logs
    if (data.logs && Array.isArray(data.logs)) {
      for (const log of data.logs) {
        const level = log.level === 'success' ? 'success' : log.level === 'error' ? 'error' : 'info';
        // Log to console for debugging/Playwright capture
        console.log(`[Backend] ${log.timestamp} ${log.message}`);
        onLog?.(`[${log.timestamp}] ${log.message}`, level);
      }
    }

    onLog?.(`Response received in ${networkTime}s`, 'success');

    return {
      text: data.text || (data.blocks ? JSON.stringify(data.blocks, null, 2) : ""),
      confidence: typeof data.confidence === 'number' ? data.confidence : 0,
      processing_time: data.processing_time,
      blocks: data.blocks || [],
      table: data.table || [],
      columns: data.columns || 0
    };
  } catch (error: any) {
    if (error.name === 'AbortError') {
      onLog?.(`Request aborted after 120s timeout`, 'error');
      throw new Error("Connection timed out (Backend busy)");
    }
    onLog?.(`Fetch Error: ${error.message}`, 'error');
    throw error;
  }
};

// Tesseract Worker Pool - reuse workers instead of creating/destroying per pass
let workerPool: any = null;
let workerInitPromise: Promise<any> | null = null;

const getOrCreateWorker = async (onLog?: (msg: string, level: any) => void): Promise<any> => {
  if (workerPool) return workerPool;

  if (workerInitPromise) return workerInitPromise;

  workerInitPromise = (async () => {
    onLog?.('Initializing Tesseract worker (one-time)...', 'info');
    const worker = await createWorker('eng', 3, {
      logger: (m: any) => {
        if (m.status === 'recognizing text') {
          const pct = Math.floor(m.progress * 100);
          if (pct % 25 === 0 && pct !== 0) onLog?.(`[Tesseract] Progress: ${pct}%`, 'info');
        }
      }
    });
    workerPool = worker;
    onLog?.('Tesseract worker ready', 'success');
    return worker;
  })();

  return workerInitPromise;
};

const prepareImageForPass = async (
  file: File,
  config: { resize?: number; dilation: boolean; crop?: boolean },
  onLog?: (msg: string, level: any) => void
): Promise<File> => {
  if (config.crop) {
    const dims = await getImageDimensions(file);
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    if (!ctx) return file;

    const cropHeight = Math.floor(dims.height * 0.15);
    canvas.width = dims.width;
    canvas.height = cropHeight;

    const img = new Image();
    const objectUrl = URL.createObjectURL(file);
    img.src = objectUrl;
    await new Promise(r => img.onload = r);
    URL.revokeObjectURL(objectUrl);

    ctx.drawImage(img, 0, 0, dims.width, cropHeight, 0, 0, dims.width, cropHeight);

    // Apply thresholding for header
    const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    for (let i = 0; i < imgData.data.length; i += 4) {
      const avg = (imgData.data[i] + imgData.data[i+1] + imgData.data[i+2]) / 3;
      const bin = avg < 200 ? 0 : 255;
      imgData.data[i] = imgData.data[i+1] = imgData.data[i+2] = bin;
    }
    ctx.putImageData(imgData, 0, 0);

    return new Promise(r => canvas.toBlob(b => r(new File([b!], 'header.jpg')), 'image/jpeg'));
  }

  return enhanceAndPadImage(file, config.resize, config.dilation, onLog);
};

const runTesseractPass = async (
  worker: any,
  file: File,
  config: { psm: string; resize?: number; dilation: boolean; desc: string; crop?: boolean },
  onLog?: (msg: string, level: any) => void
): Promise<{ text: string; confidence: number; blocks?: any[] }> => {
  onLog?.(`[Pass] ${config.desc}...`, 'info');

  const passFile = await prepareImageForPass(file, config, onLog);

  await worker.setParameters({
    tessedit_pageseg_mode: config.psm,
    preserve_interword_spaces: '1',
    user_defined_dpi: '300',
    tessedit_do_invert: '0',
  });

  const result = await worker.recognize(passFile, { rotateAuto: false });
  return {
    text: result.data.text,
    confidence: result.data.confidence,
    blocks: result.data.blocks
  };
};

export const processDocumentWithTesseract = async (
  file: File,
  mode: 'layout' | 'json',
  onLog?: (message: string, level?: 'info' | 'warn' | 'success' | 'error') => void
): Promise<OCRResponse> => {
  const startTime = performance.now();
  if (!createWorker) throw new Error("Tesseract library failed to load");

  // Get or create reusable worker
  const worker = await getOrCreateWorker(onLog);

  let bestResult = { text: '', confidence: 0 };
  const dims = await getImageDimensions(file);
  const isHighRes = dims.width > 2500 || dims.height > 2500;

  // Pass 0: Header Recovery (Top 15%, PSM 6)
  let headerText = '';
  try {
    const res0 = await runTesseractPass(worker, file, { psm: '6', dilation: false, desc: 'Header Recovery', crop: true }, onLog);
    if (res0.text.trim().length > 5) {
      headerText = res0.text.trim();
      onLog?.(`Header found: "${headerText.substring(0, 30)}..."`, 'success');
    }
  } catch (e) { /* Header pass is optional */ }

  // Pass 1: Balanced (Resized)
  try {
    const res1 = await runTesseractPass(worker, file, { psm: '3', resize: 2500, dilation: true, desc: 'Main OCR Pass' }, onLog);
    bestResult = res1;
  } catch (e) { /* Continue with empty result */ }

  // Pass 2: High-Res (Original) - only for large images
  if (isHighRes) {
    try {
      const res2 = await runTesseractPass(worker, file, { psm: '3', resize: undefined, dilation: false, desc: 'High-Res Pass' }, onLog);
      if (res2.text.length > bestResult.text.length) {
        bestResult = res2;
        onLog?.('High-res pass produced better results', 'success');
      }
    } catch (e) { /* Use previous result */ }
  }

  let finalText = bestResult.text;
  if (headerText && !finalText.includes(headerText.substring(0, 10))) {
    finalText = headerText + "\n\n" + finalText;
  }

  return {
    text: finalText,
    confidence: bestResult.confidence / 100,
    processing_time: (performance.now() - startTime) / 1000
  };
};
