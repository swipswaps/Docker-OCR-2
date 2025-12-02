# Technologies Used in Docker-OCR-2

This document provides a comprehensive audit of all technologies used in this repository and how they are applied.

---

## Backend Technologies

### 1. PaddleOCR v2.7.3
**Purpose:** Primary deep learning OCR engine

**How Used:**
- Text detection: Identifies text regions with bounding boxes
- Text recognition: Reads text from each detected region
- Angle classification disabled to avoid CPU issues (rotation handled elsewhere)

### Actual Code (app.py lines 186-212)
```python
def init_ocr_engine():
    """Initialize PaddleOCR engine with CPU-optimized settings."""
    try:
        # CPU-optimized settings from working DockerOCR project
        # CRITICAL: use_angle_cls=False to avoid "could not execute a primitive" on some CPUs
        engine = PaddleOCR(
            use_angle_cls=False,     # Disabled - causes CPU issues; rotation handled by Tesseract OSD
            lang='en',
            use_gpu=False,
            show_log=False,
            enable_mkldnn=False,     # Disable MKL-DNN to avoid CPU instruction issues
            cpu_threads=1,           # Single thread to avoid race conditions
            use_tensorrt=False,      # Disable TensorRT
            use_mp=False,            # Disable multiprocessing
            # Higher detection limits for high-resolution images (e.g., phone photos)
            det_limit_side_len=2560, # Increased from 960 to handle 4K images
            det_limit_type='max',
            det_db_thresh=0.3,       # Lower threshold to detect more text regions
            det_db_box_thresh=0.5,   # Box confidence threshold
            rec_batch_num=6,         # Recognition batch size
        )
        logger.info("PaddleOCR initialized successfully.")
        return engine
    except Exception as e:
        logger.exception("Failed to initialize PaddleOCR: %s", e)
        return None

ocr = init_ocr_engine()
```

**Location:** `app.py` lines 186-212

---

### 2. OpenCV (cv2) v4.x
**Purpose:** Image processing and table structure detection

**How Used:**
- `cv2.imdecode()`: Convert raw bytes to NumPy array
- `cv2.cvtColor()`: Convert to grayscale
- `cv2.adaptiveThreshold()`: Binarize for line detection
- `cv2.morphologyEx()`: Detect horizontal/vertical lines
- `cv2.findContours()`: Find table cell boundaries

```python
# Table detection with morphology
horizontal_kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (40, 1))
horizontal_lines = cv2.morphologyEx(thresh, cv2.MORPH_OPEN, horizontal_kernel)
```

**Location:** `app.py` lines 140-200 (table detection)

---

### 3. NumPy
**Purpose:** Array operations and image buffer handling

**How Used:**
- Image arrays from OpenCV are NumPy ndarrays
- Statistical operations (median, mean) for threshold calculations
- Bounding box coordinate manipulation

```python
np.frombuffer(file_bytes, np.uint8)  # Convert bytes to array
np.median(heights)  # Calculate median text height
```

---

### 3.5 Application Logging Configuration
**Purpose:** Ensure logs are captured by gunicorn and visible in `docker logs`

**How Used (app.py lines 33-43):**
```python
# Configure logging - use stderr so gunicorn captures it with --capture-output
handler = logging.StreamHandler(sys.stderr)  # CRITICAL: Output to stderr
handler.setLevel(logging.INFO)
handler.setFormatter(logging.Formatter(
    '[%(asctime)s] [%(levelname)7s] %(message)s',
    datefmt='%Y-%m-%d %H:%M:%S'
))

logger = logging.getLogger(__name__)
logger.setLevel(logging.INFO)
logger.addHandler(handler)
logger.propagate = False  # Prevent duplicate logs from root logger
```

**Why StreamHandler(sys.stderr):**
- Gunicorn's `--capture-output` captures stdout AND stderr
- Flask's default logger may not output correctly under gunicorn
- Explicit StreamHandler ensures reliable log capture
- `logger.propagate = False` prevents duplicate log entries

**Log Output Example:**
```
[2024-01-15 10:23:45] [   INFO] PaddleOCR initialized successfully
[2024-01-15 10:23:46] [   INFO] OCR request received: image.png (2.5MB)
[2024-01-15 10:23:52] [   INFO] OCR complete: 45 blocks detected
```

**Location:** `app.py` lines 33-43

---

### 3.6 OCR Text Cleaning (Dictionary + Regex)
**Purpose:** Post-process OCR output to fix common recognition errors

**How Used:**
Two-layer correction system in `app.py`:

### Actual Code (app.py lines 80-106) - Dictionary Corrections
```python
# TOOL: Dictionary-based OCR error corrections
# Common OCR misrecognitions - industry-specific terms
OCR_CORRECTIONS = {
    # Common letter substitutions
    'Enerqy': 'Energy',
    'enerqy': 'energy',
    'Paneis': 'Panels',
    'paneis': 'panels',
    'lnverter': 'Inverter',
    'lnverters': 'Inverters',
    'Siemens': 'Siemens',  # Often misread
    '10Ok': '100k',
    '10oK': '100K',
    'l0Ok': '100k',
    # Common merged words in solar industry
    'WSolar': 'W Solar',
    'wSolar': 'w Solar',
    'MBattery': 'M Battery',
    'PVModules': 'PV Modules',
    'PVmodules': 'PV modules',
    'kVA': 'kVA',  # Keep as-is
    # Space before common words when merged
    'Unusedwith': 'Unused with',
    'unusedwith': 'unused with',
    'Usedwith': 'Used with',
    'usedwith': 'used with',
}
```

### Actual Code (app.py lines 108-134) - Regex Corrections
```python
# TOOL: Regex replacements for context-aware fixes
# These require regex patterns for flexible matching
REGEX_CORRECTIONS = [
    # "WSolar" or "wSolar" anywhere
    (re.compile(r'\bW(Solar|Panels?|Inverters?|Energy)\b', re.IGNORECASE), r'W \1'),
    # "MBattery" pattern
    (re.compile(r'\bM(Battery|Inverter)\b', re.IGNORECASE), r'M \1'),
    # Number followed by "Panels" without space
    (re.compile(r'(\d)(Panels?)\b', re.IGNORECASE), r'\1 \2'),
    # Number followed by "Units" without space
    (re.compile(r'(\d)(Units?)\b', re.IGNORECASE), r'\1 \2'),
    # "PV" followed by word without space
    (re.compile(r'\bPV([A-Z][a-z]+)'), r'PV \1'),
    # Closing paren followed by capital letter without space
    (re.compile(r'\)([A-Z][a-z]{2,})'), r') \1'),
    # "SE)" followed by word - special case for "(SE)Solar"
    (re.compile(r'\(SE\)([A-Za-z])'), r'(SE) \1'),
    # "(SE" without closing paren followed by word - OCR missed the paren
    (re.compile(r'\(SE([A-Z][a-z]+)'), r'(SE) \1'),
    # Lowercase followed by "with" without space
    (re.compile(r'([a-z])(with)\b', re.IGNORECASE), r'\1 \2'),
    # Lowercase followed by "for" without space
    (re.compile(r'([a-z])(for)\b', re.IGNORECASE), r'\1 \2'),
    # Uppercase letter followed by lowercase word (acronym then word)
    (re.compile(r'([A-Z]{2,})([A-Z][a-z]{3,})'), r'\1 \2'),
]
```

### Actual Code (app.py lines 137-177) - Application Function
```python
def clean_ocr_text(text: str) -> str:
    """
    Apply comprehensive OCR text cleaning and normalization.
    """
    if not text:
        return text

    cleaned = text

    # Step 1: Apply dictionary-based corrections (exact matches)
    for wrong, correct in OCR_CORRECTIONS.items():
        if wrong in cleaned:
            cleaned = cleaned.replace(wrong, correct)

    # Step 2: Apply regex-based corrections (pattern matching)
    for pattern, replacement in REGEX_CORRECTIONS:
        cleaned = pattern.sub(replacement, cleaned)

    # Step 3: Fix ampersand spacing: "word&word" -> "word & word"
    cleaned = PATTERN_AMPERSAND.sub(r'\1 & \2', cleaned)

    # Step 4: Normalize multiple spaces to single space
    cleaned = re.sub(r' {2,}', ' ', cleaned)

    # Step 5: Trim whitespace
    cleaned = cleaned.strip()

    return cleaned
```

**Location:** `app.py` lines 80-177

---

### 4. Flask 3.0
**Purpose:** REST API web framework

**How Used:**
- `/health` endpoint for container health checks
- `/ocr` POST endpoint for image processing
- `/detect-rotation` endpoint for Tesseract OSD
- CORS configuration for frontend access

### Actual Code (app.py lines 45-56)
```python
# -----------------------------------------------------------------------------
# Flask Application Setup
# -----------------------------------------------------------------------------
app = Flask(__name__)
app.config['MAX_CONTENT_LENGTH'] = MAX_CONTENT_LENGTH

# CORS: Allow all origins for development
# In production, restrict to specific frontend domain
CORS(app, resources={r"/*": {
    "origins": "*",
    "methods": ["GET", "POST", "OPTIONS"],
    "allow_headers": ["Content-Type", "Accept", "X-Requested-With"]
}})
```

**Location:** `app.py` lines 45-56

---

### 5. Gunicorn 21.2
**Purpose:** Production WSGI HTTP server

**How Used:**
- Runs Flask app in production mode
- Single worker (OCR is CPU-intensive)
- Timeout configured for long OCR operations
- Captures app stdout/stderr for logging

### Actual Code (Dockerfile lines 56-70)
```dockerfile
# Production server with gunicorn
# - 1 worker (PaddleOCR is memory-intensive, single worker is safer)
# - 120s timeout for long OCR operations
# - graceful timeout for clean shutdowns
# - log-level info to show app logs
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

**Location:** `Dockerfile` lines 56-70

---

### 6. Docker
**Purpose:** Containerization for reproducible deployment

**How Used:**
- Python 3.9-slim base image
- Non-root user for security
- PaddleOCR models cached in container
- Network host mode for easy local access

```bash
docker build -t dockerocr-backend .
docker run -d --name dockerocr-backend --network=host dockerocr-backend
```

**Key Docker Commands:**
```bash
# Rebuild after code changes (required when app.py changes)
docker stop dockerocr-backend && docker rm dockerocr-backend
docker build -t dockerocr-backend .
docker run -d --name dockerocr-backend --network=host dockerocr-backend

# View logs (includes app logs via --capture-output)
docker logs -f dockerocr-backend

# Check health
curl http://localhost:5000/health

# Execute commands inside container
docker exec dockerocr-backend python3 -c "import app; print(app.MAX_CONTENT_LENGTH)"
```

**Gunicorn Configuration (Dockerfile lines 56-70):**
```dockerfile
CMD ["gunicorn", \
     "--bind", "0.0.0.0:5000", \
     "--workers", "1", \            # Single worker (PaddleOCR memory-intensive)
     "--timeout", "120", \          # 2 min timeout for large images
     "--graceful-timeout", "30", \  # Clean shutdown
     "--log-level", "info", \       # Show INFO level logs
     "--access-logfile", "-", \     # Access logs to stdout
     "--error-logfile", "-", \      # Error logs to stderr
     "--capture-output", \          # CRITICAL: Captures app stdout/stderr
     "app:app"]
```

**Key Gunicorn Flags:**
| Flag | Purpose |
|------|---------|
| `--capture-output` | Captures application stdout/stderr (enables `docker logs` to show app logs) |
| `--access-logfile -` | Writes HTTP access logs to stdout |
| `--error-logfile -` | Writes errors to stderr |
| `--workers 1` | Single worker (PaddleOCR uses ~2GB RAM per worker) |
| `--threads 2` | (Optional) Enables concurrent SSE + OCR on same worker |

**Why `--capture-output` Matters:**
Without this flag, Python `print()` and `logging` output is NOT captured by gunicorn.
`docker logs` would only show gunicorn's own logs, not application debug output.

**Location:** `Dockerfile`

---

### 6.5 Tesseract OSD (Orientation Script Detection)
**Purpose:** Detect image rotation angle for correction

**How Used:**
Backend endpoint `/detect-rotation` uses Tesseract's PSM 0 mode:

```python
# app.py lines 280-360
@app.route('/detect-rotation', methods=['POST'])
def detect_rotation():
    # Save image to temp file
    with tempfile.NamedTemporaryFile(suffix='.png', delete=False) as tmp:
        tmp.write(img_bytes)

    # Run Tesseract OSD
    result = subprocess.run(
        ['tesseract', tmp_path, 'stdout', '--psm', '0'],
        capture_output=True, text=True, timeout=30
    )

    # Parse output
    for line in result.stdout.split('\n'):
        if 'Orientation in degrees:' in line:
            orientation = int(line.split(':')[1].strip())
        elif 'Orientation confidence:' in line:
            confidence = float(line.split(':')[1].strip())
```

**OSD Output Format:**
```
Page number: 0
Orientation in degrees: 270
Rotate: 90
Orientation confidence: 14.29
Script: Latin
Script confidence: 2.00
```

**Confidence Scale:** 0-15 (14.29 = 95.3% confidence)

**Current Status:** Disabled for Docker engine to prevent over-rotation (see mistakes_and_solutions.md)

**Location:** `app.py` lines 280-365

---

## Frontend Technologies

### 7. React 19.2
**Purpose:** Component-based UI framework

**How Used:**
- Functional components with hooks
- State management: `useState`, `useCallback`, `useEffect`
- Component composition: FileUpload, DocumentViewer, Terminal

**Key Components:**
| Component | Purpose |
|-----------|---------|
| `App.tsx` | Main orchestrator |
| `FileUpload.tsx` | Drag-and-drop upload |
| `DocumentViewer.tsx` | Image preview |
| `ExtractionResult.tsx` | OCR results display |
| `Terminal.tsx` | Real-time log viewer |

---

### 8. TypeScript 5.8
**Purpose:** Type-safe JavaScript

**How Used:**
- Interface definitions for API responses
- Type annotations for function parameters
- Compile-time error catching

```typescript
interface DockerHealth {
  status: 'checking' | 'healthy' | 'unhealthy';
}
type OcrEngine = 'docker' | 'tesseract';
```

**Location:** `frontend/types.ts`

---

### 9. Vite 6.2
**Purpose:** Fast development server and build tool

**How Used:**
- Hot module replacement during development
- ES module bundling for production
- React plugin for JSX transformation

```bash
npm run dev   # Start dev server (port 5173 or 3003)
npm run build # Production build
```

**Location:** `frontend/vite.config.ts`

---

### 10. heic2any 0.0.4
**Purpose:** Convert HEIC (iPhone photos) to JPEG/PNG

**How Used:**
- Browser-based HEIC decoding
- **Automatic EXIF rotation during conversion** (CRITICAL - see below)
- Quality control for output size

### Actual Code (frontend/services/geminiService.ts lines 441-462)
```typescript
if (isHeicFile) {
  onLog?.('Detected HEIC image, converting to JPEG...', 'info');
  try {
    // heic2any handles EXIF rotation automatically during conversion
    const blob = await heic2any({ blob: file, toType: 'image/jpeg', quality: 0.85 });
    const processedBlob = Array.isArray(blob) ? blob[0] : blob;
    let tempFile = new File([processedBlob], file.name.replace(/\.heic$/i, '.jpg'), { type: 'image/jpeg' });
    const dims = await getImageDimensions(tempFile);
    onLog?.(`HEIC converted: ${dims.width}x${dims.height} (EXIF rotation applied by converter)`, 'success');

    // Resize very large images to prevent memory/size issues
    const maxDimension = 4000;
    if (dims.width > maxDimension || dims.height > maxDimension) {
      onLog?.(`Resizing large image (>${maxDimension}px) for optimal processing...`, 'info');
      tempFile = await resizeImageToMaxDimension(tempFile, maxDimension, onLog);
    }
    processedFile = tempFile;
  } catch (e: any) {
    onLog?.(`HEIC conversion failed: ${e.message}`, 'error');
    console.error("HEIC conversion failed:", e);
    isHeicFile = false; // Fall through to EXIF handling below
  }
}
```

**CRITICAL: heic2any Already Applies EXIF Rotation**

This was a major bug source (see `mistakes_and_solutions.md` #1):
- heic2any internally reads EXIF orientation and applies rotation
- The output JPEG is already correctly oriented
- **DO NOT apply additional EXIF rotation to HEIC-converted images**

**Location:** `frontend/services/geminiService.ts` lines 441-462

---

### 11. exifr 7.1.3
**Purpose:** Read EXIF metadata from images

**How Used:**
- Extract orientation tag (1, 3, 6, 8)
- Only used for non-HEIC files (heic2any handles HEIC)

### Actual Code (frontend/services/geminiService.ts lines 465-491)
```typescript
// 2. EXIF Rotation - ONLY for non-HEIC files (heic2any already handles EXIF)
if (!isHeicFile) {
  let exifAngle = 0;
  try {
      const orientation = await exifr.orientation(originalFile);
      if (orientation) {
        onLog?.(`[Verbatim] EXIF Orientation tag: ${orientation}`, 'info');
        // Standard EXIF orientation values:
        // 1 = Normal (0°), 3 = 180°, 6 = 90° CW, 8 = 270° CW
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
}
```

**Location:** `frontend/services/geminiService.ts` lines 465-491

---

### 12. Tesseract.js 5
**Purpose:** Browser-based OCR fallback engine

**How Used:**
- Fallback when Docker backend unavailable
- OSD (Orientation Script Detection) for rotation detection
- Runs entirely in browser via WebAssembly

```typescript
import Tesseract from 'tesseract.js';
const result = await Tesseract.recognize(imageFile, 'eng');
```

**Location:** `frontend/services/geminiService.ts`

---

### 13. Lucide React 0.555
**Purpose:** Icon library

**How Used:**
- UI icons for buttons and status indicators
- FileText, WifiOff, RefreshCw, Cpu, Server, etc.

```typescript
import { FileText, WifiOff, Server } from 'lucide-react';
<Server className="w-4 h-4" />
```

**Location:** `frontend/App.tsx` line 2

---

### 14. xlsx 0.18.5
**Purpose:** Excel file generation

**How Used:**
- Export OCR results to .xlsx format
- Create workbooks with table data

**Location:** `frontend/components/ExtractionResult.tsx`

---

### 15. Playwright 1.57
**Purpose:** End-to-end browser testing

**How Used:**
- Automated testing of HEIC upload flow
- Screenshot capture at processing stages
- Verification of OCR output

```typescript
import { test, expect } from '@playwright/test';

test('HEIC upload', async ({ page }) => {
  await page.goto('http://localhost:3003');
  await page.setInputFiles('input[type="file"]', heicPath);
  await page.screenshot({ path: '/tmp/debug.png' });
});
```

**Location:** `frontend/tests/debug-rotation.spec.ts`

---

## Output Tabs System

The frontend provides 5 export formats via tabbed interface:

### Tab Implementation
**Location:** `frontend/App.tsx` lines 340-480

```typescript
type OutputTab = 'text' | 'json' | 'csv' | 'xlsx' | 'sql';
const [activeOutputTab, setActiveOutputTab] = useState<OutputTab>('text');
```

### Tab Formats

| Tab | Format | How Generated |
|-----|--------|---------------|
| **Text** | Plain text | Tab-separated rows from `extractedText` state |
| **JSON** | Structured JSON | `JSON.stringify(ocrTable.map(row => row.cells), null, 2)` |
| **CSV** | Comma-separated | Cells quoted, escaped with `""` for embedded quotes |
| **XLSX** | Excel workbook | Dynamic import of `xlsx` library, `XLSX.writeFile()` |
| **SQL** | INSERT statements | Auto-generates CREATE TABLE + INSERT for each row |

### JSON Output Generation (lines 213-216)
```typescript
const jsonOutput = useMemo(() => {
  if (!ocrTable.length) return JSON.stringify({ text: extractedText }, null, 2);
  return JSON.stringify(ocrTable.map(row => row.cells), null, 2);
}, [ocrTable, extractedText]);
```

### CSV Output Generation (lines 218-224)
```typescript
const csvOutput = useMemo(() => {
  const rows = ocrTable.map(row =>
    row.cells.map((cell: string) => `"${(cell || '').replace(/"/g, '""')}"`).join(',')
  );
  return rows.join('\n');
}, [ocrTable, extractedText]);
```

### Actual Code: SQL Output Generation (frontend/App.tsx lines 226-244)
```typescript
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
```

### Actual Code: XLSX Export (frontend/App.tsx lines 259-286)
```typescript
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
```

---

## Technology Stack Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                         USER BROWSER                            │
├─────────────────────────────────────────────────────────────────┤
│  React 19 + TypeScript 5 + Vite 6                               │
│  ├── heic2any (HEIC → JPEG conversion)                          │
│  ├── exifr (EXIF orientation reading)                           │
│  ├── Tesseract.js (fallback OCR)                                │
│  ├── Lucide React (icons)                                       │
│  └── xlsx (Excel export)                                        │
├─────────────────────────────────────────────────────────────────┤
│                         HTTP (fetch)                            │
├─────────────────────────────────────────────────────────────────┤
│                      DOCKER CONTAINER                           │
│  Flask 3.0 + Gunicorn 21.2                                      │
│  ├── PaddleOCR 2.7.3 (deep learning OCR)                        │
│  ├── OpenCV 4.x (image processing)                              │
│  └── NumPy (array operations)                                   │
└─────────────────────────────────────────────────────────────────┘
```

