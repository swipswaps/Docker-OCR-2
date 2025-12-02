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

## Summary: Key Lessons Learned

| Mistake | Lesson |
|---------|--------|
| Double EXIF rotation | Understand what libraries do internally before adding more processing |
| OSD over-rotation | High confidence ≠ correct; skip redundant detection when upstream handles it |
| Y-gap too large | Use debug logging to see actual values before adjusting thresholds |
| No E2E testing | Set up Playwright/Selenium early for visual debugging |
| File size limit | Anticipate real-world file sizes; add resize/compress pipeline |
| Port mismatch | Make tests resilient to environment differences |

