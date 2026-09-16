import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

test('MiniMax 按协议设置思考默认值，保存、回显及取消补充', async ({ page }) => {
  page.setDefaultTimeout(8000);
  const headers = { 'X-Gateway-Admin': '1' };
  const status = await (await page.request.get('/api/status')).json();
  await page.goto('/');
  await page.getByLabel('管理密码', { exact: true }).fill('isolated-ui-test-password-2026');
  if (!status.configured) await page.getByLabel('再次输入密码', { exact: true }).fill('isolated-ui-test-password-2026');
  await page.getByRole('button', { name: status.configured ? (status.locked ? '解锁并进入' : '进入管理页面') : '创建并进入', exact: true }).click();
  await expect(page.locator('nav').getByRole('button', { name: /^模型配置/ })).toBeVisible();
  const connections: string[] = [];
  let modelID = '';
  const output = resolve('../output/model-thinking-qa');
  mkdirSync(output, { recursive: true });
  try {
    for (const provider of ['minimax', 'custom']) {
      const response = await page.request.post('/api/admin/connections', { headers, data: {
        name: provider + ' defaults mock', provider, enabled: true,
        endpoints: { chat: 'https://mock.invalid/v1', messages: 'https://mock.invalid/anthropic/v1' }, token: 'fake-thinking-test-key',
      } });
      expect(response.ok(), await response.text()).toBeTruthy();
      connections.push((await response.json()).id);
    }
    const response = await page.request.post('/api/admin/models', { headers, data: {
      name: '思考设置测试模型', alias: 'thinking-defaults-test', connection_id: connections[0],
      protocols: ['chat', 'messages'], upstream_model: 'MiniMax-M3', defaults: { max_tokens: 256 }, enabled: true,
    } });
    expect(response.ok(), await response.text()).toBeTruthy();
    modelID = (await response.json()).id;
    await page.reload();
    await page.locator('nav').getByRole('button', { name: /^模型配置/ }).click();
    const modal = page.getByRole('dialog');
    const row = page.locator('.models-table tbody tr').filter({ hasText: '思考设置测试模型' });
    const split = modal.getByLabel('Chat · 思考拆分', { exact: true });
    const thinking = modal.getByLabel('Messages · 思考模式', { exact: true });
    async function open() { await row.getByRole('button', { name: '编辑', exact: true }).click(); }
    async function save() {
      await modal.getByRole('button', { name: '保存模型', exact: true }).click();
      await expect(modal).toHaveCount(0);
      const state = await (await page.request.get('/api/admin/state')).json();
      return state.models.find((m: { id: string }) => m.id === modelID).defaults;
    }
    await open();
    await expect(split).toHaveValue('');
    await expect(thinking).toHaveValue('');
    await split.selectOption('true');
    await thinking.selectOption('adaptive');
    expect(await save()).toEqual({ max_tokens: 256, reasoning_split: true, thinking: { type: 'adaptive' } });
    await open();
    await expect(split).toHaveValue('true');
    await expect(thinking).toHaveValue('adaptive');
    await modal.locator('.thinking-defaults').scrollIntoViewIfNeeded();
    await page.screenshot({ path: resolve(output, 'defaults-desktop.png'), animations: 'disabled' });
    await page.setViewportSize({ width: 390, height: 844 });
    await thinking.scrollIntoViewIfNeeded();
    expect(await modal.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBeTruthy();
    await page.screenshot({ path: resolve(output, 'defaults-mobile.png'), animations: 'disabled' });
    await page.setViewportSize({ width: 1280, height: 1000 });
    const messagesProtocol = modal.locator('.protocol-options').getByRole('checkbox', { name: /Messages/ });
    await messagesProtocol.uncheck();
    await expect(thinking).toHaveCount(0);
    await messagesProtocol.check();
    await expect(thinking).toHaveValue('adaptive');
    await modal.getByRole('combobox', { name: '所属连接', exact: true }).selectOption(connections[1]);
    await expect(split).toHaveCount(0);
    await expect(thinking).toHaveCount(0);
    await modal.getByRole('combobox', { name: '所属连接', exact: true }).selectOption(connections[0]);
    await split.selectOption('false');
    await thinking.selectOption('disabled');
    expect(await save()).toEqual({ max_tokens: 256, reasoning_split: false, thinking: { type: 'disabled' } });
    await open();
    await expect(split).toHaveValue('false');
    await expect(thinking).toHaveValue('disabled');
    await split.selectOption('');
    await thinking.selectOption('');
    expect(await save()).toEqual({ max_tokens: 256 });
  } finally {
    if (!page.isClosed()) await page.keyboard.press('Escape');
    if (modelID) await page.request.delete('/api/admin/models/' + modelID, { headers }).catch(() => {});
    for (const id of connections) await page.request.delete('/api/admin/connections/' + id, { headers }).catch(() => {});
  }
});
