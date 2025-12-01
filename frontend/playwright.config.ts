import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  reporter: 'list',
  timeout: 180000, // 3 minutes per test
  use: {
    baseURL: 'http://localhost:3000',
    trace: 'on-first-retry',
    headless: false, // Show browser for debugging
    viewport: { width: 1920, height: 1080 },
    launchOptions: {
      args: ['--start-maximized'],
    },
  },
  projects: [
    {
      name: 'chromium',
      use: {
        channel: 'chromium',
        viewport: { width: 1920, height: 1080 },
      },
    },
  ],
});

