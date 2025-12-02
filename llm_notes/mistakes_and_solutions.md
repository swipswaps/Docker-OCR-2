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

### Solution
Skip EXIF rotation entirely for HEIC files since `heic2any` handles it automatically:

```typescript
let isHeicFile = file.name.toLowerCase().endsWith('.heic');

if (isHeicFile) {
  // heic2any handles EXIF rotation automatically during conversion
  const blob = await heic2any({ blob: file, toType: 'image/jpeg', quality: 0.85 });
  // ... rest of HEIC handling
}

// ONLY apply EXIF rotation for non-HEIC files
if (!isHeicFile) {
  const orientation = await exifr.orientation(originalFile);
  // ... apply rotation
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

### Solution
Skip OSD entirely for Docker engine because:
1. EXIF rotation already handles camera orientation correction
2. PaddleOCR handles text orientation internally (can read text at any angle)
3. OSD was causing problems by incorrectly "re-rotating" already-corrected images

```typescript
// For Docker engine, skip OSD - PaddleOCR handles orientation internally
if (engine === 'docker') {
  return processedFile; // Skip OSD
}

// Only use OSD for Tesseract fallback
const osdAngle = await detectOrientationOSD(processedFile, onLog);
```

### File Changed
`frontend/App.tsx`, `frontend/services/geminiService.ts`

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

### Solution
Lower the multiplier from 1.5x to 1.2x median height:

```python
# Before: y_gap_threshold = median_height * 1.5  # 124px
# After:
y_gap_threshold = median_height * 1.2  # 100px - captures 112px gap as row break
```

### File Changed
`app.py` (line 626)

---

## Mistake #4: Not Using Playwright/Selenium Earlier

### Problem
User repeatedly asked to use Playwright/Selenium for debugging, but the LLM initially tried to fix issues through code inspection alone without E2E testing.

### Root Cause
- Overconfidence in code-level debugging
- Not setting up automated visual testing from the start

### Solution
Created Playwright E2E test (`debug-rotation.spec.ts`) that:
1. Uploads HEIC file
2. Takes screenshots at each processing stage
3. Verifies image orientation visually
4. Checks OCR output row count

```typescript
test('HEIC upload and rotation debug', async ({ page }) => {
  // Upload file
  await page.setInputFiles('input[type="file"]', heicPath);
  
  // Take screenshots at each stage
  await page.screenshot({ path: '/tmp/step1-after-upload.png' });
  // ... wait for processing
  await page.screenshot({ path: '/tmp/step2-after-ocr.png' });
  
  // Verify results
  const rows = await page.locator('.result-row').count();
  expect(rows).toBe(6);
});
```

### File Created
`frontend/tests/debug-rotation.spec.ts`

---

## Mistake #5: File Size Limit Too Small (16MB)

### Problem
HEIC images from iPhones can be very large. After conversion to JPEG, a 31.48MB file was rejected with `413 - File too large`.

### Solution
1. Increase backend `MAX_CONTENT_LENGTH` from 16MB to **50MB**
2. Add frontend image resizing for images >4000px
3. Add frontend compression for images >30MB

```python
# app.py
MAX_CONTENT_LENGTH = 50 * 1024 * 1024  # 50 MB
```

```typescript
// geminiService.ts
const maxDimension = 4000;
if (dims.width > maxDimension || dims.height > maxDimension) {
  tempFile = await resizeImageToMaxDimension(tempFile, maxDimension);
}
processedFile = await compressImageForUpload(processedFile, 30); // 30MB target
```

---

## Mistake #6: Dev Server Port Mismatch in Tests

### Problem
Playwright test couldn't connect because it was trying the wrong port.

### Solution
Try multiple common ports:

```typescript
const ports = [3003, 5173, 3000];
for (const port of ports) {
  try {
    await page.goto(`http://localhost:${port}`);
    break;
  } catch { continue; }
}
```

---

---

## Mistake #7: Not Adding Debug Logging Earlier

### Problem
When the Y-gap threshold was causing row merging, it was difficult to understand why without seeing the actual gap values.

### Root Cause
- Debug logging for gap values was wrapped in `if emit_debug:` which wasn't enabled by default
- Had to modify code to always emit debug info, rebuild Docker, then test

### Solution
Add verbose debug logging that's always emitted during development:

```python
# Always emit Y gaps for debugging
gaps_sorted = sorted(gaps, reverse=True)
emit_log(f"[DEBUG] Column {col_idx} Y gaps (largest 10): {gaps_sorted[:10]}")
```

**Debug output that helped diagnose:**
```
[DEBUG] Y gap threshold for card separation: 124px (median_height=83)
[DEBUG] Column 0 Y gaps (largest 10): [198, 166, 151, 142, 112, 82, 68, 64, 59, 59]
```

This showed the 112px gap was just below the 124px threshold, causing the merge.

### File Changed
`app.py` lines 590-598

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

