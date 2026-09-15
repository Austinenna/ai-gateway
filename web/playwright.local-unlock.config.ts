import { defineConfig } from '@playwright/test';
import base from './playwright.config';

export default defineConfig({
  ...base,
  testMatch: '**/*.local-unlock.spec.ts',
  webServer: {
    command: 'node tests/start-gateway.cjs --local-no-password',
    url: 'http://127.0.0.1:18318/api/status',
    reuseExistingServer: false,
    gracefulShutdown: { signal: 'SIGTERM', timeout: 10_000 },
  },
});
