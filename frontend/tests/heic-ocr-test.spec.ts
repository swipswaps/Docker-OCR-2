import { test, expect } from '@playwright/test';

/**
 * Test HEIC file upload, rotation correction, and OCR extraction
 * Uses the actual HEIC image from Downloads folder
 *
 * IMPORTANT: Image needs 270° rotation to display correctly
 */
test('HEIC upload and OCR extraction with rotation', async ({ page }) => {
  console.log('\n═══════════════════════════════════════════════════');
  console.log('🔍 HEIC OCR TEST - IMG_0372.heic');
  console.log('═══════════════════════════════════════════════════\n');

  const logs: string[] = [];

  // Capture console messages from the app
  page.on('console', (msg) => {
    const text = msg.text();
    logs.push(text);
    // Print all logs in real-time
    console.log(`  [APP] ${text}`);
  });

  page.on('pageerror', (error) => {
    console.log(`  [ERROR] ${error.message}`);
  });

  // Navigate to the app
  await page.goto('http://localhost:3000');
  console.log('✅ App loaded\n');

  // Wait for Docker health check - look for the UI indicator
  console.log('⏳ Waiting for Docker backend to connect...\n');

  // Wait until "DOCKER ACTIVE" appears in the UI (means health check passed)
  try {
    await page.waitForSelector('text=DOCKER ACTIVE', { timeout: 30000 });
    console.log('✅ Docker backend is connected and healthy\n');
  } catch {
    console.log('⚠️ Docker backend not detected after 30s\n');
    await page.screenshot({ path: 'docker-not-connected.png' });
  }

  // Upload the HEIC file
  const heicFilePath = '/home/owner/Downloads/IMG_0372.heic';
  console.log('📤 Looking for file input...\n');

  // Wait for file input to be available
  const fileInput = page.locator('input[type="file"]');
  await fileInput.waitFor({ state: 'attached', timeout: 10000 });
  console.log('✅ File input found\n');

  await fileInput.setInputFiles(heicFilePath);
  console.log('📤 HEIC file uploaded, waiting for processing...\n');

  // Take screenshot IMMEDIATELY after upload to see original state
  await page.waitForTimeout(3000);
  await page.screenshot({ path: 'step1-after-upload.png', fullPage: true });
  console.log('📸 Screenshot: step1-after-upload.png\n');

  // Wait for HEIC conversion (can take 10-20 seconds for large HEIC files)
  console.log('⏳ Waiting for HEIC conversion...\n');
  await page.waitForTimeout(15000);
  await page.screenshot({ path: 'step2-after-heic-conversion.png', fullPage: true });
  console.log('📸 Screenshot: step2-after-heic-conversion.png\n');

  // Wait for rotation detection
  console.log('⏳ Waiting for rotation detection...\n');
  await page.waitForTimeout(10000);
  await page.screenshot({ path: 'step3-after-rotation.png', fullPage: true });
  console.log('📸 Screenshot: step3-after-rotation.png\n');

  // Check conversion results
  const heicConverted = logs.some(log => log.includes('HEIC converted'));
  const exifDetected = logs.some(log => log.includes('EXIF'));
  const rotationDetected = logs.some(log => log.includes('OSD result') || log.includes('orientation'));
  const correctionApplied = logs.some(log => log.includes('Correction needed') || log.includes('rotation correction'));
  
  console.log('📋 Processing Status:');
  console.log(`  HEIC Conversion: ${heicConverted ? '✅' : '❌'}`);
  console.log(`  EXIF Detection: ${exifDetected ? '✅' : '❌'}`);
  console.log(`  Rotation Detection: ${rotationDetected ? '✅' : '❌'}`);
  console.log(`  Correction Applied: ${correctionApplied ? '✅' : '❌'}\n`);

  // Wait for OCR processing to complete - longer wait for large images
  console.log('⏳ Waiting for OCR processing (up to 60s for large image)...\n');
  await page.waitForTimeout(60000);

  // Check for OCR completion
  const ocrComplete = logs.some(log => log.includes('Processing complete'));
  const confidenceLog = logs.find(log => log.includes('Average Confidence'));
  
  console.log(`📋 OCR Status: ${ocrComplete ? '✅ Complete' : '❌ Not complete'}`);
  if (confidenceLog) {
    console.log(`  ${confidenceLog}`);
  }

  // Get extracted text from the UI - try multiple selectors
  console.log('🔍 Looking for extracted text in UI...\n');

  // Debug: List all textareas and possible result containers
  const textareas = page.locator('textarea');
  const textareaCount = await textareas.count();
  console.log(`  Found ${textareaCount} textarea(s)\n`);

  // Try to find any textarea with content
  let extractedText = '';
  for (let i = 0; i < textareaCount; i++) {
    const textarea = textareas.nth(i);
    const value = await textarea.inputValue().catch(() => '');
    if (value) {
      console.log(`  Textarea ${i}: ${value.length} chars\n`);
      extractedText = value;
    }
  }

  // Also try to read from any pre or code block
  if (!extractedText) {
    const pre = page.locator('pre, code, [class*="result"]');
    for (let i = 0; i < await pre.count(); i++) {
      const text = await pre.nth(i).textContent() || '';
      if (text.length > 50) {
        extractedText = text;
        break;
      }
    }
  }

  console.log('\n📄 Extracted Text (first 500 chars):');
  console.log('─────────────────────────────────────────────────');
  console.log(extractedText?.substring(0, 500) || 'No text found');
  console.log('─────────────────────────────────────────────────\n');

  // Check for expected content from the solar equipment image
  const expectedTerms = ['Solar', 'Inverter', 'Panel', 'kW', 'Units'];
  const foundTerms = expectedTerms.filter(term =>
    extractedText?.toLowerCase().includes(term.toLowerCase())
  );

  console.log(`✅ Found ${foundTerms.length}/${expectedTerms.length} expected terms: ${foundTerms.join(', ')}\n`);

  // Take screenshot of final result
  await page.screenshot({ path: 'ocr-result.png', fullPage: true });
  console.log('📸 Screenshot saved to ocr-result.png\n');

  // Print all captured logs for debugging
  console.log('\n📋 All App Logs:');
  console.log('═══════════════════════════════════════════════════');
  logs.forEach(log => {
    if (log.includes('[')) {
      console.log(`  ${log}`);
    }
  });
  console.log('═══════════════════════════════════════════════════\n');

  console.log('✅ TEST COMPLETE\n');
});

