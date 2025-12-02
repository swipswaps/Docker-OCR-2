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

### Current State
- HEIC detection by filename only
- Fixed resize threshold (4000px)
- Quality hardcoded to 0.85

### Recommended Improvements

#### 2.1 Detect HEIC by Magic Bytes
```typescript
async function isHeicFile(file: File): Promise<boolean> {
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

### Current State
- Fixed Y-gap threshold (1.2x median height)
- No confidence-based filtering
- Single-pass text cleaning

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

---

## 4. Error Handling Improvements

### Current State
- Generic error messages
- No retry logic
- Errors not persisted

### Recommended Improvements

#### 4.1 Specific Error Types
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

#### 4.2 Retry Logic with Exponential Backoff
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

## 5. Performance Improvements

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

#### 5.2 Result Caching
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

## 6. Code Organization Improvements

### Current State
- Large monolithic files
- Business logic mixed with UI

### Recommended Improvements

#### 6.1 Separate Concerns
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

#### 6.2 Extract Custom Hooks
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
| Code reorganization | Medium | High | **P2** |
| Result caching | Low | Medium | **P2** |
| Visual regression tests | Low | Medium | **P3** |

