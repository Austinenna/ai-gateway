import { test, expect } from '@playwright/test';

test('请求检查器区分首个 token、正文首字及旧记录未采集状态', async ({ page }, testInfo) => {
  const record = {
    id: 'timing-new', project_id: 'inspector', project_name: '计时演示', model_id: 'test', alias: 'demo',
    upstream_model: 'demo', protocol: 'chat', started: 1789527606098, duration_ms: 29954,
    timing_version: 1, first_token_ms: 1200, first_text_ms: 25123, status: 200, state: 'complete',
    input_tokens: 12, output_tokens: 8, truncated: false,
    input: JSON.stringify({ messages: [{ role: 'system', content: '本地模拟指令' }, { role: 'user', content: '你好' }] }),
    output: JSON.stringify({ choices: [{ message: { content: '你好呀' } }] }),
  };
  const records = [record, { ...record, id: 'timing-old', project_name: '旧记录', timing_version: undefined, first_token_ms: undefined },
    { ...record, id: 'timing-empty', project_name: '空响应', first_token_ms: null, first_text_ms: null }];
  await page.route('**/api/**', route => {
    const path = new URL(route.request().url()).pathname;
    const json = path === '/api/status' ? { configured: true, authenticated: true, locked: false } :
      path === '/api/admin/state' ? { connections: [], models: [], projects: [], request_count: 3, dropped_records: 0, base_url: 'http://127.0.0.1:18318' } :
      path === '/api/admin/requests' ? records : records.find(r => path === '/api/admin/requests/' + r.id);
    return route.fulfill({ json: json ?? {} });
  });
  await page.goto('/');
  await page.locator('nav').getByRole('button', { name: /^请求记录/ }).click();
  await page.locator('.request-item').filter({ hasText: '计时演示' }).click();
  await expect(page.locator('.detail-head')).toContainText('首个 token 1,200 ms');
  await expect(page.locator('.detail-head')).toContainText('正文首字 25,123 ms');
  await page.getByRole('button', { name: '耗时', exact: true }).click();
  await expect(page.locator('.timeline')).toContainText('1,200 ms');
  await expect(page.locator('.timeline')).toContainText('25,123 ms');
  await page.screenshot({ path: testInfo.outputPath('timing-desktop.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: testInfo.outputPath('timing-mobile.png'), fullPage: true });
  await page.locator('.request-item').filter({ hasText: '旧记录' }).click();
  await expect(page.locator('.detail-head')).toContainText('首个 token 未记录');
  await expect(page.locator('.detail-head')).toContainText('正文首字 25,123 ms');
  await page.locator('.request-item').filter({ hasText: '空响应' }).click();
  await expect(page.locator('.detail-head')).toContainText('首个 token 未收到');
});
