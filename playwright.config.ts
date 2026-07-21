import { defineConfig } from '@playwright/test'

const port = 4387

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  outputDir: 'artifacts/playwright-results',
  reporter: [['list'], ['html', { outputFolder: 'artifacts/playwright-report', open: 'never' }]],
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  webServer: {
    command: 'npm run workbench:dev',
    url: `http://127.0.0.1:${port}/api/health`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      WORKBENCH_FIXTURE_MODE: '1',
      WORKBENCH_PORT: String(port),
      WORKBENCH_ARTIFACT_ROOT: 'artifacts/e2e',
    },
  },
  projects: [
    { name: 'desktop', use: { viewport: { width: 1440, height: 900 } } },
    { name: 'tablet', use: { viewport: { width: 1024, height: 768 } } },
    { name: 'mobile', use: { viewport: { width: 390, height: 844 } } },
  ],
})
