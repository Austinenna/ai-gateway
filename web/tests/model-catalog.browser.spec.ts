import { test, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

test('从厂商获取、排序搜索和选择模型，失败时保留手填', async ({ page }) => {
  page.setDefaultTimeout(8000);
  const headers = { 'X-Gateway-Admin': '1' };
  const password = 'isolated-ui-test-password-2026';
  const status = await (await page.request.get('/api/status')).json();
  await page.goto('/');
  await page.getByLabel('管理密码', { exact: true }).fill(password);
  if (!status.configured) await page.getByLabel('再次输入密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: status.configured ? (status.locked ? '解锁并进入' : '进入管理页面') : '创建并进入', exact: true }).click();
  await expect(page.locator('nav').getByRole('button', { name: /^模型配置/ })).toBeVisible();
  const requests: string[] = [];
  let mode = 'normal';
  const upstream = createServer((req, res) => {
    requests.push(req.url || '');
    if (req.method !== 'GET' || req.headers.authorization !== 'Bearer fake-catalog-browser-key') {
      res.writeHead(403).end('invalid request'); return;
    }
    if (mode === 'unsupported') { res.writeHead(404).end('private-fake-upstream-error'); return; }
    res.setHeader('Content-Type', 'application/json');
    if (mode === 'empty') { res.end(JSON.stringify({ data: [] })); return; }
    if (mode === 'unknown') {
      res.end(JSON.stringify({ data: [{ id: 'unknown-z', created: 0 }, { id: 'unknown-a' }] })); return;
    }
    if (req.url?.startsWith('/anthropic/v1/models')) {
      if (req.headers['x-api-key'] !== 'fake-catalog-browser-key') { res.writeHead(403).end(); return; }
      res.end(JSON.stringify({ data: [{ id: 'messages-model', display_name: 'Messages 模型', created_at: '2025-03-01T00:00:00Z' }] })); return;
    }
    const data = Array.from({ length: 25 }, (_, i) => ({ id: `catalog-${String(i + 1).padStart(2, '0')}`, display_name: `候选模型 ${i + 1}`, created: 1735689600 + i * 86400 }));
    res.end(JSON.stringify({ data: [...data, { id: 'unknown-model', display_name: '很长的模型名称与端点标识-'.repeat(3), created: 0 }] }));
  });
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const address = upstream.address();
  if (!address || typeof address === 'string') throw new Error('missing mock address');
  const base = `http://127.0.0.1:${address.port}`;
  const connections: string[] = [];
  const models: string[] = [];
  const modal = page.getByRole('dialog');
  const output = resolve('../output/model-catalog-qa');
  mkdirSync(output, { recursive: true });
  async function addConnection(name: string) {
    const response = await page.request.post('/api/admin/connections', { headers, data: { name, provider: 'custom', endpoints: { chat: base + '/v1', messages: base + '/anthropic/v1' }, token: 'fake-catalog-browser-key', enabled: true } });
    expect(response.ok(), await response.text()).toBeTruthy();
    const c = await response.json(); connections.push(c.id); return c;
  }
  try {
    const connection = await addConnection('模型目录测试连接');
    const other = await addConnection('目录切换连接');
    await page.reload();
    await page.locator('nav').getByRole('button', { name: /^模型配置/ }).click();
    await page.getByRole('button', { name: '新增模型', exact: true }).first().click();
    await modal.getByRole('combobox', { name: '所属连接', exact: true }).selectOption(connection.id);
    await expect(modal.getByRole('button', { name: '获取模型列表', exact: true })).toBeEnabled();
    expect(requests).toHaveLength(0);
    await modal.getByLabel('调用别名').fill('catalog-choice');
    await modal.getByRole('button', { name: '获取模型列表', exact: true }).click();
    const results = modal.locator('.catalog-results button');
    await expect(results).toHaveCount(10);
    await expect(results.first()).toHaveAttribute('aria-label', '选择 catalog-25');
    await expect(modal.getByRole('status')).toContainText('时间未知的排在后面');
    await modal.getByLabel('显示数量').selectOption('20');
    await expect(results).toHaveCount(20);
    await modal.getByLabel('显示数量').selectOption('all');
    await expect(results).toHaveCount(26);
    await expect(results.last()).toHaveAttribute('aria-label', '选择 unknown-model');
    await modal.getByLabel('搜索模型').fill('catalog-01');
    await expect(results).toHaveCount(1);
    await results.first().click();
    await expect(modal.getByLabel('厂商模型 ID')).toHaveValue('catalog-01');
    await expect(modal.getByLabel('显示名称')).toHaveValue('候选模型 1');
    await expect(modal.getByLabel('调用别名')).toHaveValue('catalog-choice');
    await modal.getByLabel('显示名称').fill('我的稳定名称');
    await modal.getByLabel('搜索模型').fill('catalog-25');
    await results.first().click();
    await expect(modal.getByLabel('显示名称')).toHaveValue('我的稳定名称');
    await modal.getByLabel('搜索模型').fill('');
    await modal.getByLabel('显示数量').selectOption('10');
    await page.setViewportSize({ width: 1440, height: 1100 });
    await modal.locator('.model-catalog-field').scrollIntoViewIfNeeded();
    await page.screenshot({ path: resolve(output, 'catalog-desktop.png'), animations: 'disabled' });
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.screenshot({ path: resolve(output, 'catalog-dark.png'), animations: 'disabled' });
    await page.emulateMedia({ colorScheme: 'light' });
    await page.setViewportSize({ width: 390, height: 844 });
    await modal.getByLabel('搜索模型').fill('unknown-model');
    await modal.locator('.model-catalog-field').scrollIntoViewIfNeeded();
    expect(await modal.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBeTruthy();
    await page.screenshot({ path: resolve(output, 'catalog-mobile.png'), animations: 'disabled' });
    await page.setViewportSize({ width: 1280, height: 1000 });
    await modal.getByLabel('获取协议').selectOption('messages');
    await expect(modal.getByRole('region', { name: '厂商模型列表' })).toHaveCount(0);
    await modal.getByRole('button', { name: '获取模型列表', exact: true }).click();
    await expect(results).toHaveCount(1);
    await expect(results.first()).toHaveAttribute('aria-label', '选择 messages-model');
    expect(requests.some(p => p.startsWith('/anthropic/v1/models?'))).toBeTruthy();
    await results.first().click();
    await modal.getByRole('button', { name: '保存模型', exact: true }).click();
    await expect(modal).toHaveCount(0);
    const state = await (await page.request.get('/api/admin/state')).json();
    const model = state.models.find((m: { alias: string }) => m.alias === 'catalog-choice');
    models.push(model.id);
    expect(model.upstream_model).toBe('messages-model');
    expect(model.protocols).toEqual(['chat', 'messages']); // Discovery does not assert support or alter protocol choices.
    await page.locator('.models-table tbody tr').filter({ hasText: '我的稳定名称' }).getByRole('button', { name: '编辑', exact: true }).click();
    await modal.getByRole('button', { name: '获取模型列表', exact: true }).click();
    await expect(results).toHaveCount(10);
    await modal.getByRole('combobox', { name: '所属连接', exact: true }).selectOption(other.id);
    await expect(modal.getByRole('region', { name: '厂商模型列表' })).toHaveCount(0);
    await expect(modal.getByLabel('厂商模型 ID')).toHaveValue('messages-model');
    mode = 'unsupported';
    await modal.getByRole('button', { name: '获取模型列表', exact: true }).click();
    await expect(modal.getByRole('alert')).toContainText('不支持模型列表');
    await expect(modal.getByRole('alert')).not.toContainText('private-fake');
    await modal.getByLabel('厂商模型 ID').fill('manual-model');
    await expect(modal.getByRole('button', { name: '保存模型', exact: true })).toBeEnabled();
    mode = 'unknown';
    await modal.getByRole('button', { name: '获取模型列表', exact: true }).click();
    await expect(modal.getByRole('status')).toContainText('无法判断新旧');
    await expect(results.first()).toHaveAttribute('aria-label', '选择 unknown-a');
    mode = 'empty';
    await modal.getByRole('button', { name: '刷新模型列表', exact: true }).click();
    await expect(modal.getByRole('status')).toContainText('列表为空');
    await modal.getByRole('button', { name: '保存模型', exact: true }).click();
    await expect(modal).toHaveCount(0);
    const saved = await (await page.request.get('/api/admin/state')).json();
    expect(saved.models.find((m: { id: string }) => m.id === model.id).upstream_model).toBe('manual-model');
    expect(requests.every(p => p.includes('/models'))).toBeTruthy();
  } finally {
    if (!page.isClosed()) await page.keyboard.press('Escape');
    for (const id of models) await page.request.delete('/api/admin/models/' + id, { headers }).catch(() => {});
    for (const id of connections) await page.request.delete('/api/admin/connections/' + id, { headers }).catch(() => {});
    await new Promise<void>((resolve, reject) => upstream.close(err => err ? reject(err) : resolve()));
  }
});
