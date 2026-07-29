import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/mobile',
  testMatch: '**/*.e2e.ts',
  outputDir: './test-results/mobile',
  fullyParallel: false,
  workers: 1,
  reporter: 'line',
  use: {
    baseURL: 'http://127.0.0.1:4173',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'android-pixel-7',
      use: {
        ...devices['Pixel 7'],
      },
    },
    {
      name: 'ios-iphone-15',
      use: {
        ...devices['iPhone 15'],
      },
    },
  ],
  webServer: {
    command: 'npm run dev:web -- --host 127.0.0.1 --port 4173',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
