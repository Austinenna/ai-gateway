import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

test('请求直接展示网关适配，原始请求保留且其他厂商与旧记录不显示转换', async ({ page }) => {
  const base = {
    project_id: 'shared-project', model_id: 'model', protocol: 'messages',
    started: 1789570000000, duration_ms: 1200, first_token_ms: 400, first_text_ms: 600,
    timing_version: 1, status: 200, state: 'complete', input_tokens: 100, output_tokens: 20, truncated: false,
    input: JSON.stringify({ model: 'custom-reasoner', max_tokens: 40192, thinking: { type: 'enabled', budget_tokens: 8192 }, messages: [{ role: 'user', content: '你好' }] }),
    output: JSON.stringify({ content: [{ type: 'thinking', thinking: '本地模拟思考。' }, { type: 'text', text: '你好！' }] }),
  };
  const records = [
    { ...base, id: 'adapted', project_name: '已适配请求', alias: 'custom-reasoner', upstream_model: 'MiniMax-M3', provider: 'minimax', adaptations: [{ rule: 'minimax-m3-messages-thinking', field: 'thinking.type', before: 'enabled', after: 'adaptive', removed_fields: ['thinking.budget_tokens'] }] },
    { ...base, id: 'zhipu', project_name: '智谱请求', alias: 'custom-glm', upstream_model: 'glm-5', provider: 'zhipu' },
    { ...base, id: 'old', project_name: '旧请求', alias: 'custom-reasoner', upstream_model: 'MiniMax-M3', provider: 'minimax' },
  ];
  await page.route('**/api/**', route => {
    const path = new URL(route.request().url()).pathname;
    const json = path === '/api/status' ? { configured: true, authenticated: true, locked: false } :
      path === '/api/admin/state' ? { connections: [], models: [], projects: [], request_count: 3, dropped_records: 0, base_url: 'http://127.0.0.1:18318' } :
      path === '/api/admin/requests' ? records : records.find(r => path === '/api/admin/requests/' + r.id);
    return route.fulfill({ json: json ?? {} });
  });
  await page.goto('/');
  await page.locator('nav').getByRole('button', { name: /^请求记录/ }).click();
  await page.locator('.request-item').filter({ hasText: '已适配请求' }).click();
  const adaptation = page.getByRole('region', { name: '网关参数适配' });
  await expect(adaptation).toContainText('enabled → adaptive');
  await expect(adaptation).toContainText('思考预算不再生效');
  const output = resolve('../output/provider-adapters-qa');
  mkdirSync(output, { recursive: true });
  for (const [label, width, scheme] of [['desktop', 1440, 'light'], ['mobile', 390, 'light'], ['dark', 1440, 'dark']] as const) {
    await page.setViewportSize({ width, height: 950 });
    await page.emulateMedia({ colorScheme: scheme });
    await adaptation.scrollIntoViewIfNeeded();
    await expect(adaptation).toBeVisible();
    expect(await adaptation.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBeTruthy();
    await page.screenshot({ path: resolve(output, `adaptation-${label}.png`), animations: 'disabled' });
  }
  await page.getByRole('button', { name: '原始数据', exact: true }).click();
  await expect(page.locator('.detail-content > pre').first()).toContainText('"budget_tokens": 8192');
  await expect(page.locator('.detail-content > pre').first()).toContainText('"type": "enabled"');
  for (const name of ['智谱请求', '旧请求']) {
    await page.locator('.request-item').filter({ hasText: name }).click();
    await expect(adaptation).toHaveCount(0);
  }
});
