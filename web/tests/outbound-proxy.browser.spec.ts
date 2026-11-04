import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

test('出站代理地址与连接级开关', async ({ page }) => {
  const headers = { 'X-Gateway-Admin': '1' };
  const password = 'isolated-ui-test-password-2026';
  const status = await (await page.request.get('/api/status')).json();
  await page.goto('/');
  await page.getByLabel('管理密码', { exact: true }).fill(password);
  if (!status.configured) await page.getByLabel('再次输入密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: status.configured ? (status.locked ? '解锁并进入' : '进入管理页面') : '创建并进入', exact: true }).click();
  const output = resolve('../output/outbound-proxy-qa');
  mkdirSync(output, { recursive: true });
  const panel = page.getByRole('region', { name: '出站代理' });
  const address = panel.getByLabel('代理地址');
  const modal = page.getByRole('dialog');
  const name = '出站代理验证连接';
  const row = page.locator('.connection-row').filter({ hasText: name });
  let connectionID = '';
  try {
    await page.locator('nav').getByRole('button', { name: /^连接与模型/ }).click();
    await expect(panel).toContainText('未设置');

    await test.step('无效地址被拒绝并保留输入，有效地址保存后回显', async () => {
      await address.fill('127.0.0.1:7890');
      await panel.getByRole('button', { name: '保存', exact: true }).click();
      await expect(page.locator('.error').first()).toContainText('有效的代理地址');
      await expect(address).toHaveValue('127.0.0.1:7890');
      await address.fill('http://127.0.0.1:7890/');
      await panel.getByRole('button', { name: '保存', exact: true }).click();
      await expect(address).toHaveValue('http://127.0.0.1:7890');
      await expect(panel).toContainText('还没有连接开启');
    });

    await test.step('新建连接打开走出站代理，列表和编辑窗口均回显', async () => {
      await page.getByRole('button', { name: '新增连接', exact: true }).first().click();
      await modal.getByLabel('连接名称', { exact: true }).fill(name);
      await modal.getByRole('combobox', { name: '厂商', exact: true }).selectOption('custom');
      await modal.getByLabel('Chat Completions 基础端点').fill('https://openrouter.test/api/v1');
      await modal.getByLabel('厂商 Token').fill('fake-outbound-proxy-key');
      await expect(modal).toContainText('http://127.0.0.1:7890');
      await modal.getByRole('checkbox', { name: '走出站代理', exact: true }).check();
      await modal.getByRole('button', { name: '保存连接', exact: true }).click();
      await expect(modal).toHaveCount(0);
      await expect(row).toContainText('走代理');
      await expect(panel).toContainText('1 个连接走代理');
      const state = await (await page.request.get('/api/admin/state', { headers })).json();
      const saved = state.connections.find((c: { name: string }) => c.name === name);
      connectionID = saved.id;
      expect(saved.use_proxy).toBe(true);
      for (const [label, width, height, scheme] of [['desktop', 1440, 1000, 'light'], ['mobile', 390, 844, 'light'], ['dark', 1440, 1000, 'dark']] as const) {
        await page.setViewportSize({ width, height }); await page.emulateMedia({ colorScheme: scheme });
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
        await page.screenshot({ path: resolve(output, 'connections-' + label + '.png') });
      }
      await page.setViewportSize({ width: 1280, height: 1000 }); await page.emulateMedia({ colorScheme: 'light' });
      await row.getByRole('button', { name: '编辑' }).click();
      await expect(modal.getByRole('checkbox', { name: '走出站代理', exact: true })).toBeChecked();
      await modal.getByRole('checkbox', { name: '走出站代理', exact: true }).uncheck();
      await modal.getByRole('button', { name: '保存连接', exact: true }).click();
      await expect(modal).toHaveCount(0);
      await expect(row).not.toContainText('走代理');
    });

    await test.step('清空地址回到环境变量', async () => {
      await address.fill('');
      await panel.getByRole('button', { name: '清除', exact: true }).click();
      await expect(panel).toContainText('未设置');
    });
  } finally {
    await page.request.put('/api/admin/outbound-proxy', { headers, data: { url: '' } });
    if (connectionID) await page.request.delete('/api/admin/connections/' + connectionID + '?cascade=true', { headers, data: { model_ids: [] } });
  }
});
