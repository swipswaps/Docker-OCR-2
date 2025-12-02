# Improvements and Best Practices

This document outlines improvements that can be made to the Docker-OCR-2 codebase, following best practices and avoiding the mistakes documented in `mistakes_and_solutions.md`.

---

## 1. Testing Improvements

### Current State
- Single Playwright test file for debugging
- No unit tests
- Manual testing required for most changes

### Recommended Improvements

#### 1.1 Add Comprehensive E2E Test Suite
Create tests for all critical paths:

```typescript
// frontend/tests/ocr-suite.spec.ts
test.describe('OCR Processing', () => {
  test('should process JPEG files correctly', async ({ page }) => {
    // Test JPEG without HEIC conversion
  });
  
  test('should process HEIC files without double rotation', async ({ page }) => {
    // Verify HEIC → JPEG conversion doesn't over-rotate
  });
  
  test('should detect correct number of rows', async ({ page }) => {
    // Verify row separation algorithm
  });
  
  test('should handle multi-column documents', async ({ page }) => {
    // Test column-first layout detection
  });
  
  test('should fallback to Tesseract when Docker unavailable', async ({ page }) => {
    // Stop Docker, verify graceful fallback
  });
});
```

#### 1.2 Add Backend Unit Tests
```python
# tests/test_ocr.py
import pytest
from app import clean_ocr_text, cluster_column_blocks

def test_clean_ocr_text_spacing():
    assert clean_ocr_text("Frames&Temper") == "Frames & Temper"
    assert clean_ocr_text("928Panels") == "928 Panels"

def test_y_gap_threshold():
    # Verify 1.2x median height calculation
    blocks = [{"_y": 0, "_h": 80}, {"_y": 100, "_h": 80}]
    # Gap of 20px should NOT trigger row break with median 80 * 1.2 = 96
```

#### 1.3 Add Visual Regression Tests
Use Playwright's screenshot comparison:

```typescript
test('visual regression - document viewer', async ({ page }) => {
  await page.setInputFiles('input[type="file"]', testImagePath);
  await expect(page).toHaveScreenshot('document-viewer.png');
});
```

---

## 2. Image Processing Improvements

### Current State (frontend/services/geminiService.ts lines 436-440)
```typescript
// Current: HEIC detection by filename/MIME type only
let isHeicFile = file.name.toLowerCase().endsWith('.heic') || file.type === 'image/heic';
```

### Recommended Improvements

#### 2.1 Detect HEIC by Magic Bytes
```typescript
async function isHeicFile(file: File): Promise<boolean> {
  // Check file extension first (fast path)
  if (file.name.toLowerCase().endsWith('.heic') || file.type === 'image/heic') {
    return true;
  }
  // Fallback: check magic bytes for misnamed files
  const buffer = await file.slice(0, 12).arrayBuffer();
  const view = new DataView(buffer);
  // Check for 'ftyp' box and HEIC brand
  const ftyp = view.getUint32(4);
  return ftyp === 0x66747970; // 'ftyp'
}
```

#### 2.2 Adaptive Image Sizing Based on Content
```typescript
async function getOptimalMaxDimension(file: File): Promise<number> {
  const dims = await getImageDimensions(file);
  const megapixels = (dims.width * dims.height) / 1_000_000;
  
  // Scale based on image complexity
  if (megapixels > 20) return 3000;  // Very large images
  if (megapixels > 10) return 4000;  // Large images
  return 5000;  // Normal images
}
```

#### 2.3 Preserve EXIF for Non-Rotation Metadata
Currently all EXIF is lost during canvas rotation. Preserve important metadata:

```typescript
async function rotateWithExifPreservation(file: File, angle: number): Promise<File> {
  const exifData = await exifr.parse(file, { 
    pick: ['DateTimeOriginal', 'Make', 'Model', 'GPSLatitude', 'GPSLongitude'] 
  });
  const rotatedFile = await rotateImageCanvas(file, angle);
  // Re-embed EXIF into rotated image (requires piexifjs or similar)
  return embedExif(rotatedFile, exifData);
}
```

---

## 3. Backend OCR Improvements

### Current State (app.py lines 622-625)
```python
# Current: Fixed Y-gap threshold (1.2x median height)
# Determine Y gap threshold for separating cards
# Use 1.2x median height to capture more card breaks (lowered from 1.5)
y_gap_threshold = median_height * 1.2
emit_log(f"[DEBUG] Y gap threshold for card separation: {y_gap_threshold:.0f}px (median_height={median_height:.0f})")
```

### Recommended Improvements

#### 3.1 Adaptive Y-Gap Threshold
Use gap distribution analysis instead of fixed multiplier:

```python
def calculate_adaptive_threshold(gaps: list[float]) -> float:
    """Find natural break in gap distribution using Jenks natural breaks."""
    if len(gaps) < 3:
        return median(gaps) * 1.2
    
    sorted_gaps = sorted(gaps, reverse=True)
    
    # Find largest drop between consecutive gaps
    max_drop = 0
    threshold_idx = 0
    for i in range(len(sorted_gaps) - 1):
        drop = sorted_gaps[i] - sorted_gaps[i + 1]
        if drop > max_drop:
            max_drop = drop
            threshold_idx = i
    
    # Threshold between the groups
    return (sorted_gaps[threshold_idx] + sorted_gaps[threshold_idx + 1]) / 2
```

#### 3.2 Confidence-Based Block Filtering
Filter out low-confidence noise blocks:

```python
def filter_low_confidence_blocks(blocks: list, min_confidence: float = 0.3) -> list:
    """Remove blocks that are likely OCR noise."""
    return [b for b in blocks if b["confidence"] >= min_confidence]
```

#### 3.3 Two-Pass Text Cleaning
First pass: structural fixes. Second pass: dictionary corrections.

```python
def clean_ocr_text_v2(text: str) -> str:
    # Pass 1: Structural spacing
    text = re.sub(r'([a-z])([A-Z])', r'\1 \2', text)  # camelCase
    text = re.sub(r'(\d)([A-Za-z])', r'\1 \2', text)  # 928Panels

    # Pass 2: Dictionary corrections (after spacing fixed)
    corrections = {'Enerqy': 'Energy', 'Unusedwith': 'Unused with'}
    for wrong, right in corrections.items():
        text = text.replace(wrong, right)

    return text
```

#### 3.4 Expand OCR Dictionary
Current dictionary has ~20 entries. Should be expanded:

```python
OCR_CORRECTIONS_EXPANDED = {
    # Existing
    'Enerqy': 'Energy',
    'Paneis': 'Panels',

    # Add common OCR errors
    'lnverter': 'Inverter',   # l→I
    'Siemens': 'Siemens',
    'Schneider': 'Schneider',
    'rn': 'm',                 # Often confused
    'cl': 'd',                 # Often confused

    # Industry-specific (solar)
    'Mwh': 'MWh',
    'Kwh': 'kWh',
    'Pv': 'PV',

    # Common OCR artifacts
    '|': 'I',                  # Pipe→I
    '0': 'O',                  # Context-dependent
}
```

#### 3.5 Add Spell-Check Pass
Use a lightweight spell checker for final cleanup:

```python
from spellchecker import SpellChecker

def spell_check_pass(text: str, domain_words: set) -> str:
    spell = SpellChecker()
    spell.word_frequency.load_words(domain_words)  # Add industry terms

    words = text.split()
    corrected = []
    for word in words:
        if word.lower() not in spell:
            correction = spell.correction(word.lower())
            if correction and correction != word.lower():
                corrected.append(correction)
            else:
                corrected.append(word)
        else:
            corrected.append(word)
    return ' '.join(corrected)
```

---

## 4. Output Tab Improvements

### Current State (frontend/App.tsx lines 226-244)
```typescript
// Current: SQL generates generic column names (col_a, col_b, etc.)
const sqlOutput = useMemo(() => {
  const tableName = 'ocr_results';
  const colCount = ocrColumns || 1;
  const colNames = Array.from({ length: colCount }, (_, i) => `col_${String.fromCharCode(97 + i)}`);
  const colDefs = colNames.map(c => `  ${c} TEXT`).join(',\n');
  // ...
}, [ocrTable, ocrColumns, extractedText]);
```

**Current Limitations:**
- No column headers detected from data
- SQL uses generic col_a, col_b names
- No Markdown table export

### Recommended Improvements

#### 4.1 Add Column Header Detection
Use first row as headers if it looks like a header row:

```typescript
function detectHeaders(table: OcrRow[]): { hasHeaders: boolean; headers: string[] } {
  if (table.length < 2) return { hasHeaders: false, headers: [] };

  const firstRow = table[0].cells;
  const secondRow = table[1].cells;

  // Heuristics: header row usually has no numbers, shorter text
  const firstRowNumeric = firstRow.some(c => /^\d+$/.test(c));
  const secondRowNumeric = secondRow.some(c => /^\d+$/.test(c));

  if (!firstRowNumeric && secondRowNumeric) {
    return { hasHeaders: true, headers: firstRow };
  }
  return { hasHeaders: false, headers: [] };
}
```

#### 4.2 Improve SQL Generation
Generate proper column names and add data types:

```typescript
const sqlOutput = useMemo(() => {
  const { hasHeaders, headers } = detectHeaders(ocrTable);
  const colNames = hasHeaders
    ? headers.map(h => h.toLowerCase().replace(/\s+/g, '_'))
    : Array.from({ length: colCount }, (_, i) => `col_${i + 1}`);

  const dataRows = hasHeaders ? ocrTable.slice(1) : ocrTable;

  return `CREATE TABLE ocr_results (
  id SERIAL PRIMARY KEY,
  ${colNames.map(c => `${c} TEXT`).join(',\n  ')}
);

${dataRows.map(row =>
  `INSERT INTO ocr_results (${colNames.join(', ')}) VALUES (${
    row.cells.map(c => `'${c.replace(/'/g, "''")}'`).join(', ')
  });`
).join('\n')}`;
}, [ocrTable]);
```

#### 4.3 Add Markdown Table Export
```typescript
const markdownOutput = useMemo(() => {
  if (!ocrTable.length) return extractedText;

  const { hasHeaders, headers } = detectHeaders(ocrTable);
  const dataRows = hasHeaders ? ocrTable.slice(1) : ocrTable;
  const headerRow = hasHeaders ? headers : ocrTable[0].cells.map((_, i) => `Column ${i + 1}`);

  const header = `| ${headerRow.join(' | ')} |`;
  const separator = `| ${headerRow.map(() => '---').join(' | ')} |`;
  const rows = dataRows.map(row => `| ${row.cells.join(' | ')} |`);

  return [header, separator, ...rows].join('\n');
}, [ocrTable]);
```

---

## 5. Docker Improvements

### Current State (Dockerfile lines 56-70)
```dockerfile
# Current: Single worker, 120s timeout, no GPU, no model caching
CMD ["gunicorn", \
     "--bind", "0.0.0.0:5000", \
     "--workers", "1", \
     "--timeout", "120", \
     "--graceful-timeout", "30", \
     "--log-level", "info", \
     "--access-logfile", "-", \
     "--error-logfile", "-", \
     "--capture-output", \
     "app:app"]
```

### Recommended Improvements

#### 5.1 Add Volume Mount for Model Caching
Avoid re-downloading models on every container rebuild:

```bash
# Create persistent volume for models
docker volume create paddleocr-models

# Run with volume mount
docker run -d --name dockerocr-backend \
  -v paddleocr-models:/home/appuser/.paddleocr \
  --network=host dockerocr-backend
```

#### 5.2 Add Health Check to Dockerfile
```dockerfile
HEALTHCHECK --interval=30s --timeout=10s --start-period=120s --retries=3 \
  CMD curl -f http://localhost:5000/health || exit 1
```

#### 5.3 Add GPU Support (Optional)
```dockerfile
# Use NVIDIA CUDA base image
FROM nvidia/cuda:11.8-runtime-ubuntu22.04

# Install PaddlePaddle GPU version
RUN pip install paddlepaddle-gpu paddleocr
```

```bash
# Run with GPU access
docker run -d --gpus all --name dockerocr-backend dockerocr-backend
```

#### 5.4 Add Request Queuing
For high-traffic scenarios, add Redis queue:

```python
from rq import Queue
from redis import Redis

redis_conn = Redis()
q = Queue(connection=redis_conn)

@app.route('/ocr', methods=['POST'])
def ocr_endpoint():
    job = q.enqueue(process_ocr, file_bytes, job_timeout=300)
    return jsonify({'job_id': job.id, 'status': 'queued'})

@app.route('/ocr/<job_id>', methods=['GET'])
def get_result(job_id):
    job = Job.fetch(job_id, connection=redis_conn)
    if job.is_finished:
        return jsonify(job.result)
    return jsonify({'status': job.get_status()})
```

#### 5.5 Enable Threading for SSE (Server-Sent Events)
If adding real-time progress streaming:

```dockerfile
# Dockerfile - enable threads for concurrent SSE + OCR
CMD ["gunicorn", \
     "--bind", "0.0.0.0:5000", \
     "--workers", "1", \
     "--threads", "2", \         # NEW: 2 threads per worker
     "--timeout", "120", \
     "--capture-output", \
     "app:app"]
```

**Why `--threads 2`:**
- Allows SSE endpoint to stream progress while OCR runs
- Single-threaded worker blocks SSE during OCR processing
- 2 threads = 1 for SSE, 1 for OCR

#### 5.6 Include Logs in OCR Response
Alternative to SSE - include debug logs in response:

```python
@app.route('/ocr', methods=['POST'])
def ocr_endpoint():
    logs = []
    def log(msg):
        logs.append(f"[{time.strftime('%H:%M:%S')}] {msg}")
        logger.info(msg)

    log("Starting OCR processing")
    # ... OCR processing ...
    log(f"Detected {len(blocks)} text blocks")

    return jsonify({
        'success': True,
        'table': result,
        'debug_logs': logs  # Include logs in response
    })
```

**Advantage:** Eliminates real-time streaming complexities while still providing debug info.

---

## 6. Error Handling Improvements

### Current State
- Generic error messages
- No retry logic
- Errors not persisted

### Recommended Improvements

#### 6.1 Specific Error Types
```typescript
class HeicConversionError extends Error {
  constructor(message: string, public readonly originalError?: Error) {
    super(`HEIC conversion failed: ${message}`);
  }
}

class OcrTimeoutError extends Error {
  constructor(public readonly timeoutMs: number) {
    super(`OCR timed out after ${timeoutMs}ms`);
  }
}
```

#### 6.2 Retry Logic with Exponential Backoff
```typescript
async function fetchWithRetry(
  url: string, 
  options: RequestInit, 
  maxRetries = 3
): Promise<Response> {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const response = await fetch(url, options);
      if (response.ok) return response;
      if (response.status === 503) {
        // Backend initializing, wait and retry
        await sleep(Math.pow(2, attempt) * 1000);
        continue;
      }
      throw new Error(`HTTP ${response.status}`);
    } catch (e) {
      if (attempt === maxRetries - 1) throw e;
      await sleep(Math.pow(2, attempt) * 1000);
    }
  }
  throw new Error('Max retries exceeded');
}
```

---

## 7. Performance Improvements

### Current State
- Full image sent to backend
- No caching
- Synchronous processing

### Recommended Improvements

#### 5.1 Progressive Image Loading
Show low-res preview immediately, process full-res in background:

```typescript
async function processWithPreview(file: File, onPreview: (url: string) => void) {
  // Immediate: create tiny preview
  const preview = await resizeImage(file, 400);
  onPreview(URL.createObjectURL(preview));
  
  // Background: process full image
  const processed = await preprocessImage(file);
  return processed;
}
```

#### 7.2 Result Caching
Cache OCR results by image hash:

```typescript
const ocrCache = new Map<string, OcrResult>();

async function cachedOcr(file: File): Promise<OcrResult> {
  const hash = await hashFile(file);
  if (ocrCache.has(hash)) return ocrCache.get(hash)!;
  
  const result = await processOcr(file);
  ocrCache.set(hash, result);
  return result;
}
```

---

## 8. Code Organization Improvements

### Current State
- Large monolithic files
- Business logic mixed with UI

### Recommended Improvements

#### 8.1 Separate Concerns
```
frontend/
├── services/
│   ├── imagePreprocessing.ts   # HEIC, EXIF, resize
│   ├── ocrService.ts           # Docker/Tesseract calls
│   └── exportService.ts        # CSV, XLSX generation
├── hooks/
│   ├── useDockerHealth.ts
│   ├── useOcrProcessing.ts
│   └── useImageUpload.ts
└── utils/
    ├── imageUtils.ts
    └── textCleaning.ts
```

#### 8.2 Extract Custom Hooks
```typescript
// hooks/useDockerHealth.ts
function useDockerHealth(pollInterval = 15000) {
  const [health, setHealth] = useState<DockerHealth>({ status: 'checking' });
  
  useEffect(() => {
    const check = async () => {
      const isHealthy = await checkDockerHealth();
      setHealth({ status: isHealthy ? 'healthy' : 'unhealthy' });
    };
    check();
    const interval = setInterval(check, pollInterval);
    return () => clearInterval(interval);
  }, [pollInterval]);
  
  return health;
}
```

---

## Summary: Priority Matrix

| Improvement | Impact | Effort | Priority |
|-------------|--------|--------|----------|
| E2E test suite | High | Medium | **P0** |
| Backend unit tests | High | Low | **P0** |
| Adaptive Y-gap threshold | High | Medium | **P1** |
| HEIC detection by magic bytes | Medium | Low | **P1** |
| Retry logic | Medium | Low | **P1** |
| Expand OCR dictionary | Medium | Low | **P1** |
| Column header detection | Medium | Medium | **P1** |
| Docker volume for models | Medium | Low | **P1** |
| Code reorganization | Medium | High | **P2** |
| Result caching | Low | Medium | **P2** |
| Markdown table export | Low | Low | **P2** |
| GPU support | Low | High | **P3** |
| Visual regression tests | Low | Medium | **P3** |
| Request queuing (Redis) | Low | High | **P3** |

