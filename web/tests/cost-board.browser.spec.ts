import { test, expect } from '@playwright/test';

test('成本看板缓存命中率按缓存读取占全部输入计算，不超过 100%', async ({ page }) => {
  const total = { cost: 1, requests: 3, input_tokens: 100, cache_read_tokens: 870, output_tokens: 10, audio_seconds: 0 };
  await page.route('**/api/**', route => {
    const url = new URL(route.request().url());
    const json = url.pathname === '/api/status' ? { configured: true, authenticated: true, locked: false } :
      url.pathname === '/api/admin/state' ? { connections: [], models: [], projects: [], request_count: 0, dropped_records: 0, base_url: '' } :
      url.pathname === '/api/admin/usage' ? { total, groups: [] } : {};
    return route.fulfill({ json });
  });
  await page.goto('/?view=costs');
  const tile = page.locator('.cost-board .p').filter({ hasText: 'CACHE HIT' });
  await expect(tile.locator('.kv')).toHaveText('90%');
});
