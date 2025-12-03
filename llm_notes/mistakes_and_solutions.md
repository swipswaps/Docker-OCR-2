# LLM Mistakes and Solutions

This document audits mistakes made during the Docker-OCR-2 development conversation and their solutions.

## Mistake #1: Double EXIF Rotation for HEIC Files

### Problem
After converting HEIC to JPEG using `heic2any`, the code read the original EXIF orientation tag and applied rotation **again**, causing images to be rotated 90° incorrectly.

### Root Cause
- `heic2any` automatically applies EXIF rotation during HEIC→JPEG conversion
- The code then read the EXIF tag from the **original** HEIC file and applied rotation a second time
- This resulted in: `90° (heic2any) + 90° (manual) = 180°` or other incorrect angles

### Incorrect Code Pattern
```typescript
// heic2any already applies EXIF rotation
const blob = await heic2any({ blob: file, toType: 'image/jpeg' });

// WRONG: Reading EXIF from original file and rotating again
const orientation = await exifr.orientation(originalFile);
if (orientation === 6) {
  processedFile = await rotateImageCanvas(processedFile, 90); // Double rotation!
}
```

### Correct Code (frontend/services/geminiService.ts lines 436-491)
```typescript
// 1. Convert HEIC with smart resizing for large images
// NOTE: heic2any automatically applies EXIF rotation during conversion,
// so we must NOT apply EXIF rotation again for HEIC files.
let isHeicFile = file.name.toLowerCase().endsWith('.heic') || file.type === 'image/heic';

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

### File Changed
`frontend/services/geminiService.ts` (lines 436-491)

---

## Mistake #2: OSD Incorrectly Rotating Already-Corrected Images

### Problem
After EXIF rotation correctly fixed image orientation, the OSD (Orientation Script Detection) ran and incorrectly detected the image as needing another 270° rotation, making it upside down.

### Root Cause
- OSD reported confidence of 14.29, which on Tesseract's 0-15 scale is **95.3%** (14.29/15)
- This passed the 30% threshold check, so the (incorrect) rotation was applied
- OSD was "confidently wrong" about text orientation

### Correct Code (frontend/services/geminiService.ts lines 493-510)
```typescript
// 3. Optimization Path for Docker
if (engine === 'docker') {
    onLog?.('Engine: Docker. Skipping frontend enhancements to prevent backend conflicts.', 'info');
    // Compress large images to stay within backend upload limit (50MB, target 30MB for safety)
    processedFile = await compressImageForUpload(processedFile, 30, onLog);
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
```

**Key Point:** Docker engine returns early at line 498, skipping OSD entirely. Only Tesseract path uses OSD.

### File Changed
`frontend/services/geminiService.ts` (lines 493-510)

---

## Mistake #3: Y-Gap Threshold Too Large (Row Merging)

### Problem
First two rows of a 6-row document were merged into one row. Output showed 5 rows instead of 6.

### Root Cause
- Y-gap threshold was `median_height * 1.5 = 83 * 1.5 = 124px`
- Gap between rows 1 and 2 was **112px** (smaller than 124px threshold)
- Algorithm treated them as same row because gap was "too small"

### Debug Output
```
Y gap threshold for card separation: 124px (median_height=83)
Column 0 Y gaps (largest 10): [198, 166, 151, 142, 112, 82, 68, 64, 59, 59]
Cards per column: [5]  <-- Should be [6]
```

### Correct Code (app.py lines 622-637)
```python
# Determine Y gap threshold for separating cards
# Cards on the same sheet are separated by visible gaps (usually >100px)
# Lines within a card are close together (usually <80px)
# Use 1.2x median height to capture more card breaks (lowered from 1.5)
y_gap_threshold = median_height * 1.2
emit_log(f"[DEBUG] Y gap threshold for card separation: {y_gap_threshold:.0f}px (median_height={median_height:.0f})")

# Cluster blocks within each column
column_cards = {}
max_cards_per_col = 0
for col_idx in range(num_cols):
    cards = cluster_column_blocks(columns[col_idx], y_gap_threshold, col_idx, emit_debug=True)
    column_cards[col_idx] = cards
    max_cards_per_col = max(max_cards_per_col, len(cards))

emit_log(f"[DEBUG] Cards per column: {[len(column_cards[i]) for i in range(num_cols)]}")
```

### File Changed
`app.py` (lines 622-637)

---

## Mistake #4: Not Using Playwright/Selenium Earlier

### Problem
User repeatedly asked to use Playwright/Selenium for debugging, but the LLM initially tried to fix issues through code inspection alone without E2E testing.

### Root Cause
- Overconfidence in code-level debugging
- Not setting up automated visual testing from the start

### Correct Code (frontend/tests/debug-rotation.spec.ts)
```typescript
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Debug test for IMG_0371.heic rotation issue
 * Takes screenshots at each processing step to diagnose orientation problems
 */
test('Debug IMG_0371 rotation', async ({ page }) => {
  const screenshotDir = '/tmp/rotation-debug';
  if (!fs.existsSync(screenshotDir)) {
    fs.mkdirSync(screenshotDir, { recursive: true });
  }

  console.log('\n═══════════════════════════════════════════════════');
  console.log('🔍 DEBUG: IMG_0371.heic Rotation Test');
  console.log('═══════════════════════════════════════════════════\n');

  const logs: string[] = [];

  // Capture all console messages
  page.on('console', (msg) => {
    const text = msg.text();
    logs.push(text);
    if (text.includes('[') || text.includes('HEIC') || text.includes('EXIF') ||
        text.includes('rotation') || text.includes('Rotation') || text.includes('orientation')) {
      console.log(`  [APP] ${text}`);
    }
  });

  // Navigate to the app (try multiple ports)
  const ports = [3003, 5173, 3000];
  let connected = false;
  for (const port of ports) {
    try {
      await page.goto(`http://localhost:${port}`, { timeout: 5000 });
      console.log(`✅ Connected on port ${port}`);
      connected = true;
      break;
    } catch {
      console.log(`Port ${port} not available, trying next...`);
    }
  }
  if (!connected) throw new Error('No dev server found on ports 3003, 5173, or 3000');

  // Wait for Docker connection
  try {
    await page.waitForSelector('text=DOCKER ACTIVE', { timeout: 15000 });
    console.log('✅ Docker backend connected\n');
  } catch {
    console.log('⚠️ Docker not detected, waiting for Tesseract...\n');
  }

  // Find and upload the file
  const heicFilePath = '/home/owner/Downloads/IMG_0371.heic';
  const fileInput = page.locator('input[type="file"]');
  await fileInput.waitFor({ state: 'attached', timeout: 10000 });
  await fileInput.setInputFiles(heicFilePath);

  // Screenshot at each stage
  await page.waitForTimeout(1000);
  await page.screenshot({ path: `${screenshotDir}/01-upload.png`, fullPage: true });
  await page.waitForTimeout(15000);
  await page.screenshot({ path: `${screenshotDir}/02-heic-converted.png`, fullPage: true });
  await page.waitForTimeout(30000);
  await page.screenshot({ path: `${screenshotDir}/03-ocr-complete.png`, fullPage: true });

  // Analyze logs for debugging
  const heicLog = logs.find(l => l.includes('HEIC converted'));
  const exifLog = logs.find(l => l.includes('EXIF Orientation'));
  console.log(`  HEIC: ${heicLog || 'not found'}`);
  console.log(`  EXIF Tag: ${exifLog || 'not found'}`);
  console.log(`\n📁 Screenshots saved to: ${screenshotDir}`);
});
```

### File Created
`frontend/tests/debug-rotation.spec.ts`

---

## Mistake #5: File Size Limit Too Small (16MB)

### Problem
HEIC images from iPhones can be very large. After conversion to JPEG, a 31.48MB file was rejected with `413 - File too large`.

### Correct Code (app.py lines 23-31)
```python
# -----------------------------------------------------------------------------
# Configuration
# -----------------------------------------------------------------------------
MAX_CONTENT_LENGTH = 50 * 1024 * 1024  # 50 MB max file size (supports high-res images)
ALLOWED_EXTENSIONS = {'png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'tiff', 'tif'}
ALLOWED_MIMETYPES = {
    'image/png', 'image/jpeg', 'image/gif', 'image/bmp',
    'image/webp', 'image/tiff'
}
```

### Correct Code (frontend/services/geminiService.ts lines 451-457)
```typescript
// Resize very large images to prevent memory/size issues
const maxDimension = 4000;
if (dims.width > maxDimension || dims.height > maxDimension) {
  onLog?.(`Resizing large image (>${maxDimension}px) for optimal processing...`, 'info');
  tempFile = await resizeImageToMaxDimension(tempFile, maxDimension, onLog);
}
processedFile = tempFile;
```

### Correct Code (frontend/services/geminiService.ts line 497)
```typescript
// Compress large images to stay within backend upload limit (50MB, target 30MB for safety)
processedFile = await compressImageForUpload(processedFile, 30, onLog);
```

---

## Mistake #6: Dev Server Port Mismatch in Tests

### Problem
Playwright test couldn't connect because it was trying the wrong port.

### Correct Code (frontend/tests/debug-rotation.spec.ts lines 32-44)
```typescript
// Navigate to the app (try multiple ports)
const ports = [3003, 5173, 3000];
let connected = false;
for (const port of ports) {
  try {
    await page.goto(`http://localhost:${port}`, { timeout: 5000 });
    console.log(`✅ Connected on port ${port}`);
    connected = true;
    break;
  } catch {
    console.log(`Port ${port} not available, trying next...`);
  }
}
if (!connected) throw new Error('No dev server found on ports 3003, 5173, or 3000');
```

---

## Mistake #7: Not Adding Debug Logging Earlier

### Problem
When the Y-gap threshold was causing row merging, it was difficult to understand why without seeing the actual gap values.

### Root Cause
- Debug logging for gap values was wrapped in `if emit_debug:` which wasn't enabled by default
- Had to modify code to always emit debug info, rebuild Docker, then test

### Correct Code (app.py lines 622-637)
```python
# Determine Y gap threshold for separating cards
# Use 1.2x median height to capture more card breaks (lowered from 1.5)
y_gap_threshold = median_height * 1.2
emit_log(f"[DEBUG] Y gap threshold for card separation: {y_gap_threshold:.0f}px (median_height={median_height:.0f})")

# Cluster blocks within each column
column_cards = {}
max_cards_per_col = 0
for col_idx in range(num_cols):
    cards = cluster_column_blocks(columns[col_idx], y_gap_threshold, col_idx, emit_debug=True)
    column_cards[col_idx] = cards
    max_cards_per_col = max(max_cards_per_col, len(cards))

emit_log(f"[DEBUG] Cards per column: {[len(column_cards[i]) for i in range(num_cols)]}")
```

**Debug output that helped diagnose:**
```
[DEBUG] Y gap threshold for card separation: 124px (median_height=83)
[DEBUG] Column 0 Y gaps (largest 10): [198, 166, 151, 142, 112, 82, 68, 64, 59, 59]
```

This showed the 112px gap was just below the 124px threshold, causing the merge.

### File Changed
`app.py` lines 622-637

### Related: Gunicorn Log Capture

Another logging issue: Python `print()` and `logging` output wasn't visible in `docker logs`.

**Root Cause:** Gunicorn doesn't capture application stdout/stderr by default.

### Correct Code (Dockerfile lines 56-70)
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

### Correct Code (app.py lines 33-43)
```python
# Configure logging - use stderr so gunicorn captures it with --capture-output
# Create handler explicitly for reliable output
handler = logging.StreamHandler(sys.stderr)
handler.setLevel(logging.INFO)
handler.setFormatter(logging.Formatter('[%(asctime)s] [%(levelname)7s] %(message)s', datefmt='%Y-%m-%d %H:%M:%S'))

logger = logging.getLogger(__name__)
logger.setLevel(logging.INFO)
logger.addHandler(handler)
# Prevent duplicate logs from root logger
logger.propagate = False
```

---

## Mistake #8: Iterative Fixes Without Root Cause Analysis

### Problem
Multiple attempts were made to fix the rotation issue before identifying the true root cause:
1. First tried removing OSD detection
2. Then tried adjusting EXIF rotation logic
3. Finally identified heic2any was already applying EXIF

### Root Cause
- Didn't trace the full image processing pipeline before making changes
- Each "fix" addressed symptoms rather than the underlying issue

### Solution
Before fixing, trace the complete pipeline:

```
HEIC file → heic2any (applies EXIF rotation) → processedFile
                                                    ↓
processedFile → exifr.orientation() reads ORIGINAL file's EXIF
                                                    ↓
Manual rotation applied (WRONG - already rotated!)
```

The fix was understanding that `exifr.orientation(originalFile)` was reading from the **original** HEIC, not the converted JPEG.

### Lesson
**Always trace data flow through the entire pipeline before making changes.**

---

## Mistake #9: Not Checking Library Documentation

### Problem
Assumed `heic2any` was a simple format converter, didn't realize it handles EXIF orientation.

### Root Cause
- Didn't check heic2any documentation/source
- Made assumptions about library behavior

### Solution
The heic2any library description clearly states:
> "Converts HEIC/HEIF images to JPEG/PNG in the browser. **Automatically handles EXIF orientation.**"

### Lesson
**Always read library documentation for features that might affect your use case.**

---

## Summary: Key Lessons Learned

| Mistake | Lesson |
|---------|--------|
| Double EXIF rotation | Understand what libraries do internally before adding more processing |
| OSD over-rotation | High confidence ≠ correct; skip redundant detection when upstream handles it |
| Y-gap too large | Use debug logging to see actual values before adjusting thresholds |
| No E2E testing | Set up Playwright/Selenium early for visual debugging |
| File size limit | Anticipate real-world file sizes; add resize/compress pipeline |
| Port mismatch | Make tests resilient to environment differences |
| No debug logging | Add verbose logging from the start for troubleshooting |
| Iterative fixes | Trace full pipeline before making changes |
| Skipped docs | Always read library documentation |

---

## Debugging Checklist (For Future)

Before making changes to fix an issue:

1. **Add debug logging** to see actual values at each step
2. **Run E2E test** (Playwright) to reproduce issue consistently
3. **Trace full pipeline** from input to output
4. **Check library docs** for features that might affect behavior
5. **Test with multiple inputs** to confirm fix doesn't break other cases
6. **Check thresholds** - are hardcoded values appropriate for all cases?

### Docker Debugging Commands
```bash
# View live logs
docker logs -f dockerocr-backend

# Check specific output
docker logs dockerocr-backend 2>&1 | grep -E "Y gap|threshold|Cards"

# Rebuild and test
docker stop dockerocr-backend && docker rm dockerocr-backend
docker build -t dockerocr-backend . && docker run -d --name dockerocr-backend --network=host dockerocr-backend
sleep 30 && curl http://localhost:5000/health

# Run Playwright test
cd frontend && npx playwright test debug-rotation.spec.ts --headed
```
