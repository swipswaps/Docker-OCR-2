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
  console.log('✅ App loaded\n');

  // Wait for Docker connection
  try {
    await page.waitForSelector('text=DOCKER ACTIVE', { timeout: 15000 });
    console.log('✅ Docker backend connected\n');
  } catch {
    console.log('⚠️ Docker not detected, waiting for Tesseract...\n');
  }

  // Find and upload the file
  const heicFilePath = '/home/owner/Downloads/IMG_0371.heic';
  console.log(`📤 Uploading: ${heicFilePath}\n`);

  const fileInput = page.locator('input[type="file"]');
  await fileInput.waitFor({ state: 'attached', timeout: 10000 });
  await fileInput.setInputFiles(heicFilePath);

  // Screenshot 1: Immediately after upload
  await page.waitForTimeout(1000);
  await page.screenshot({ path: `${screenshotDir}/01-upload.png`, fullPage: true });
  console.log('📸 01-upload.png\n');

  // Wait for HEIC conversion
  console.log('⏳ Waiting for HEIC conversion...\n');
  await page.waitForTimeout(15000);
  await page.screenshot({ path: `${screenshotDir}/02-heic-converted.png`, fullPage: true });
  console.log('📸 02-heic-converted.png\n');

  // Wait for processing to complete
  console.log('⏳ Waiting for OCR processing...\n');
  await page.waitForTimeout(30000);
  await page.screenshot({ path: `${screenshotDir}/03-ocr-complete.png`, fullPage: true });
  console.log('📸 03-ocr-complete.png\n');

  // Analyze logs
  console.log('\n📋 Key Processing Steps:');
  console.log('─────────────────────────────────────────────────');

  const heicLog = logs.find(l => l.includes('HEIC converted'));
  const exifLog = logs.find(l => l.includes('EXIF Orientation'));
  const exifApplied = logs.find(l => l.includes('EXIF rotation applied'));
  const osdSkipped = logs.find(l => l.includes('Skipping OSD'));
  const resizedLog = logs.find(l => l.includes('Resized to'));
  const uploadLog = logs.find(l => l.includes('Uploading') && l.includes('MB'));
  const completeLog = logs.find(l => l.includes('Processing complete'));

  console.log(`  HEIC: ${heicLog || 'not found'}`);
  console.log(`  EXIF Tag: ${exifLog || 'not found'}`);
  console.log(`  EXIF Applied: ${exifApplied || 'not found'}`);
  console.log(`  OSD Skipped: ${osdSkipped || 'not found'}`);
  console.log(`  Resized: ${resizedLog || 'not found'}`);
  console.log(`  Upload: ${uploadLog || 'not found'}`);
  console.log(`  Complete: ${completeLog || 'not found'}`);
  console.log('─────────────────────────────────────────────────\n');

  // Check image preview orientation
  const preview = page.locator('img').first();
  if (await preview.isVisible()) {
    const box = await preview.boundingBox();
    if (box) {
      console.log(`📐 Preview dimensions: ${box.width}x${box.height}`);
      console.log(`   Aspect ratio: ${(box.width/box.height).toFixed(2)}`);
      console.log(`   Orientation: ${box.width > box.height ? 'LANDSCAPE' : 'PORTRAIT'}\n`);
    }
  }

  // Print all logs for full debugging
  console.log('\n📋 All Processing Logs:');
  console.log('═══════════════════════════════════════════════════');
  logs.filter(l => l.includes('[')).forEach(log => console.log(`  ${log}`));
  console.log('═══════════════════════════════════════════════════\n');

  console.log(`\n📁 Screenshots saved to: ${screenshotDir}`);
  console.log('   View with: eog /tmp/rotation-debug/*.png\n');
});
