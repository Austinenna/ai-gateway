import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

test('模型上下文窗口保存、回显、公开目录与窄屏显示', async ({ page }) => {
  const headers = { 'X-Gateway-Admin': '1' };
  const status = await (await page.request.get('/api/status')).json();
  await page.goto('/');
  await page.getByLabel('管理密码', { exact: true }).fill('isolated-ui-test-password-2026');
  if (!status.configured) await page.getByLabel('再次输入密码', { exact: true }).fill('isolated-ui-test-password-2026');
  await page.getByRole('button', { name: status.configured ? (status.locked ? '解锁并进入' : '进入管理页面') : '创建并进入', exact: true }).click();
  await expect(page.locator('nav').getByRole('button', { name: /^模型配置/ })).toBeVisible();
  const connection = await page.request.post('/api/admin/connections', { headers, data: {
    name: '上下文测试连接', provider: 'custom', enabled: true,
    endpoints: { chat: 'https://mock.invalid/v1', 'dashscope-asr': 'https://mock.invalid/api/v1' }, token: 'fake-context-ui-key',
  } });
  expect(connection.ok()).toBeTruthy();
  const connectionID = (await connection.json()).id;
  let modelID = '';
  const output = resolve('../output/context-window-qa');
  mkdirSync(output, { recursive: true });
  try {
    await page.reload();
    await page.locator('nav').getByRole('button', { name: /^模型配置/ }).click();
    await page.getByRole('button', { name: '新增模型', exact: true }).first().click();
    const modal = page.getByRole('dialog');
    await modal.getByLabel('显示名称', { exact: false }).fill('上下文测试模型');
    await modal.getByLabel('调用别名', { exact: false }).fill('context-ui-test');
    await modal.getByRole('combobox', { name: '所属连接', exact: true }).selectOption(connectionID);
    await modal.locator('.protocol-options').getByRole('checkbox', { name: /百炼/ }).uncheck();
    await modal.getByLabel('厂商模型 ID', { exact: false }).fill('mock-long-context');
    const window = modal.getByRole('spinbutton', { name: /上下文窗口/ });
    await expect(window).toHaveValue('');
    await window.fill('1048576');
    await modal.getByRole('spinbutton', { name: /默认 max_tokens/ }).fill('8192');
    await modal.getByRole('button', { name: '保存模型', exact: true }).click();
    await expect(modal).toHaveCount(0);
    const state = await (await page.request.get('/api/admin/state')).json();
    const saved = state.models.find((m: { alias: string }) => m.alias === 'context-ui-test');
    modelID = saved.id;
    expect(saved.context_window).toBe(1048576);
    expect(saved.defaults.max_tokens).toBe(8192);
    const catalog = await (await page.request.get('/api/public/models')).json();
    expect(catalog.data.find((m: { id: string }) => m.id === 'context-ui-test').context_window).toBe(1048576);
    await page.reload();
    await page.locator('nav').getByRole('button', { name: /^模型配置/ }).click();
    const row = page.locator('.models-table tbody tr').filter({ hasText: '上下文测试模型' });
    await expect(row).toContainText('上下文 1,048,576 Token');
    await page.screenshot({ path: resolve(output, 'models-desktop.png') });
    await row.getByRole('button', { name: '编辑', exact: true }).click();
    await expect(window).toHaveValue('1048576');
    await expect(modal.getByRole('spinbutton', { name: /默认 max_tokens/ })).toHaveValue('8192');
    await window.scrollIntoViewIfNeeded();
    await page.screenshot({ path: resolve(output, 'context-desktop.png') });
    await page.setViewportSize({ width: 390, height: 844 });
    await window.evaluate(el => el.scrollIntoView({ block: 'center' }));
    expect(await modal.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBeTruthy();
    await page.screenshot({ path: resolve(output, 'context-mobile.png') });
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.screenshot({ path: resolve(output, 'context-mobile-dark.png') });
    await page.setViewportSize({ width: 1280, height: 1000 });
    await page.emulateMedia({ colorScheme: 'light' });
    await window.fill('');
    await modal.getByRole('button', { name: '保存模型', exact: true }).click();
    await expect(modal).toHaveCount(0);
    await expect(row).toContainText('上下文未设置');
    await row.getByRole('button', { name: '编辑', exact: true }).click();
    await expect(window).toHaveValue('');
    await window.fill('1000000');
    await modal.getByLabel('厂商模型 ID', { exact: false }).fill('different-model');
    await expect(window).toHaveValue('');
    await window.fill('1000000');
    await modal.locator('.protocol-options').getByRole('checkbox', { name: /Chat/ }).uncheck();
    await modal.locator('.protocol-options').getByRole('checkbox', { name: /百炼/ }).check();
    await expect(window).toHaveCount(0);
    await modal.getByRole('button', { name: '保存模型', exact: true }).click();
    await expect(modal).toHaveCount(0);
    await expect(row.locator('.model-context')).toHaveCount(0);
    const asrState = await (await page.request.get('/api/admin/state')).json();
    expect(asrState.models.find((m: { id: string }) => m.id === modelID).context_window).toBe(0);
  } finally {
    if (!page.isClosed()) await page.keyboard.press('Escape');
    if (modelID) await page.request.delete('/api/admin/models/' + modelID, { headers });
    await page.request.delete('/api/admin/connections/' + connectionID, { headers });
  }
});
