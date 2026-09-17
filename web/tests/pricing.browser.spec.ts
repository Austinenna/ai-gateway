import { test, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

test('价格配置、历史快照、不同币种和项目费用完整流程', async ({ page }) => {
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', chunk => raw += chunk);
    req.on('end', () => {
      const body = JSON.parse(raw);
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ choices: [{ message: { content: 'mock answer' } }], usage: body.model === 'partial' ? { completion_tokens: 1000 } : { prompt_tokens: 10000, completion_tokens: 1000, prompt_tokens_details: { cached_tokens: 8000 } } }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  const headers = { 'X-Gateway-Admin': '1' };
  const out = resolve('../output/pricing-qa');
  mkdirSync(out, { recursive: true });
  let connectionID = '', projectID = '';
  const modelIDs: string[] = [];
  async function request(method: 'post' | 'put', path: string, data: unknown) {
    const r = await page.request[method](path, { headers, data });
    expect(r.ok(), await r.text()).toBeTruthy(); return r.json();
  }
  try {
    const status = await (await page.request.get('/api/status')).json();
    await request('post', status.configured ? '/api/login' : '/api/setup', { password: 'isolated-ui-test-password-2026' });
    connectionID = (await request('post', '/api/admin/connections', { name: '费用验收连接', provider: 'custom', enabled: true, endpoints: { chat: `http://127.0.0.1:${address.port}/v1` }, token: 'fake-pricing-browser-key' })).id;
    const model = await request('post', '/api/admin/models', { name: '费用验收模型', alias: 'pricing-cny', connection_id: connectionID, upstream_model: 'priced', protocols: ['chat'], enabled: true });
    modelIDs.push(model.id);
    await page.goto('/');
    await page.locator('nav').getByRole('button', { name: /^模型配置/ }).click();
    const row = page.locator('.models-table tbody tr').filter({ hasText: '费用验收模型' });
    await expect(row).toContainText('未配置价格');
    await row.getByRole('button', { name: '编辑', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('计费方式', { exact: true }).selectOption('token');
    await dialog.getByLabel('输入单价', { exact: true }).fill('2');
    await dialog.getByLabel('输出单价', { exact: true }).fill('8');
    await dialog.getByLabel('缓存读取单价', { exact: true }).fill('0.2');
    await dialog.getByLabel('缓存写入单价', { exact: true }).fill('2.5');
    await dialog.getByLabel('价格来源', { exact: true }).fill('https://example.com/mock-pricing');
    await dialog.getByLabel('计费备注', { exact: true }).fill('验收用假价格');
    await expect(dialog.locator('.pricing-reference')).toContainText('¥0.028');
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      await dialog.locator('.model-pricing-fields').scrollIntoViewIfNeeded();
      expect(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
      await page.screenshot({ path: resolve(out, `pricing-form-${width}.png`) });
    }
    await dialog.getByRole('button', { name: '保存模型', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(row).toContainText('输入 ¥2.00 / 输出 ¥8.00');
    const state = await (await page.request.get('/api/admin/state')).json();
    const configured = state.models.find((m: { id: string }) => m.id === model.id);
    expect(configured.pricing.updated_at).toBeGreaterThan(0);
    for (const [alias, upstream, pricing] of [
      ['pricing-usd', 'priced', { ...configured.pricing, currency: 'USD' }],
      ['pricing-plan', 'priced', { mode: 'subscription', note: '现有包月套餐' }],
      ['pricing-unknown', 'priced', { mode: 'unconfigured' }],
      ['pricing-partial', 'partial', configured.pricing],
    ] as const) {
      const m = await request('post', '/api/admin/models', { ...model, name: alias, alias, upstream_model: upstream, pricing });
      modelIDs.push(m.id);
    }
    const project = await request('post', '/api/admin/projects', { name: '费用验收项目', enabled: true, model_ids: modelIDs });
    projectID = project.project.id;
    let firstID = '';
    for (const alias of ['pricing-cny', 'pricing-usd', 'pricing-plan', 'pricing-unknown', 'pricing-partial']) {
      const response = await page.request.post('/v1/chat/completions', { headers: { Authorization: `Bearer ${project.token}` }, data: { model: alias, messages: [{ role: 'user', content: 'local mock only' }] } });
      expect(response.ok()).toBe(true);
      if (alias === 'pricing-cny') firstID = response.headers()['x-request-id'];
    }
    await request('put', '/api/admin/models/' + model.id, { ...configured, pricing: { ...configured.pricing, input_per_million: 20 } });
    const record = await (await page.request.get('/api/admin/requests/' + firstID)).json();
    expect(record.cost.amount).toBe(0.0136);
    expect(record.cost.pricing.input_per_million).toBe(2);
    await page.reload();
    await page.getByLabel('监控项目', { exact: true }).selectOption(projectID);
    await expect(page.locator('.monitor-cost')).toContainText('¥0.0216 · $0.0136');
    await expect(page.locator('.monitor-cost')).toContainText('完整估算 2 / 5 次');
    await expect(page.locator('.monitor-cost')).toContainText('部分估算 1 次');
    await expect(page.locator('.monitor-cost')).toContainText('未配价 1 次');
    await expect(page.locator('.monitor-cost')).toContainText('套餐 1 次');
    await expect(page.locator('.monitor-project-costs')).toContainText('费用验收项目');
    await expect(page.locator('.monitor-models')).toContainText('¥0.0136');
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.locator('.workspace').evaluate(el => el.scrollTop = 0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: resolve(out, `cost-overview-${width}.png`), fullPage: width === 390 });
      await page.locator('.monitor-models').scrollIntoViewIfNeeded();
      await page.screenshot({ path: resolve(out, `cost-models-${width}.png`) });
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.screenshot({ path: resolve(out, 'cost-overview-dark.png') });
    await page.emulateMedia({ colorScheme: 'light' });
    await page.getByRole('button', { name: '查看请求 ' + firstID, exact: true }).click();
    await expect(page.locator('.request-cost-banner')).toContainText('¥0.0136');
    await page.getByRole('button', { name: '性能与用量', exact: true }).click();
    await expect(page.locator('.detail-cost')).toContainText('缓存读取');
    await expect(page.locator('.detail-cost')).toContainText('¥0.0016');
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.locator('.detail-cost').scrollIntoViewIfNeeded();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: resolve(out, `cost-detail-${width}.png`) });
    }
  } finally {
    if (projectID) await page.request.delete('/api/admin/projects/' + projectID, { headers });
    for (const id of modelIDs) await page.request.delete('/api/admin/models/' + id, { headers });
    if (connectionID) await page.request.delete('/api/admin/connections/' + connectionID, { headers });
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
