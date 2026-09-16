import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

test('厂商双协议、自定义连接与手填端点保存', async ({ page }) => {
  const headers = { 'X-Gateway-Admin': '1' };
  const password = 'isolated-ui-test-password-2026';
  const status = await (await page.request.get('/api/status')).json();
  await page.goto('/');
  await page.getByLabel('管理密码', { exact: true }).fill(password);
  if (!status.configured) await page.getByLabel('再次输入密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: status.configured ? (status.locked ? '解锁并进入' : '进入管理页面') : '创建并进入', exact: true }).click();
  await page.locator('nav').getByRole('button', { name: /^厂商连接/ }).click();
  const modal = page.getByRole('dialog');
  const provider = modal.getByRole('combobox', { name: '厂商', exact: true });
  const protocol = modal.getByRole('combobox', { name: '接口协议', exact: true });
  const endpoint = modal.getByLabel('API 基础端点');
  const row = (name: string) => page.locator('.connection-row, .connection-card').filter({ hasText: name });
  const output = resolve('../output/custom-connections-qa');
  mkdirSync(output, { recursive: true });
  const fixtureNames = ['智谱 Messages 验证', '自定义 Chat 验证', '自定义 Messages 验证'];
  let modelCalls = 0;
  page.on('request', request => {
    if (/\/v1\/(chat\/completions|messages)$|\/api\/admin\/models\/[^/]+\/test$/.test(new URL(request.url()).pathname)) modelCalls++;
  });
  const openNew = () => page.getByRole('button', { name: '新增连接', exact: true }).first().click();
  const save = async (name: string) => {
    await modal.getByLabel('连接名称', { exact: true }).fill(name);
    await modal.getByLabel('厂商 Token').fill('fake-custom-browser-key');
    await modal.getByRole('button', { name: '保存连接', exact: true }).click();
    await expect(modal).toHaveCount(0);
    await expect(row(name)).toBeVisible();
  };
  try {
    await test.step('两家厂商均可选两种协议，默认端点正确切换', async () => {
      await openNew();
      await expect(protocol).toBeEnabled();
      await protocol.selectOption('messages');
      await expect(endpoint).toHaveValue('https://open.bigmodel.cn/api/anthropic/v1');
      await provider.selectOption('minimax');
      await expect(protocol).toHaveValue('messages');
      await expect(endpoint).toHaveValue('https://api.minimax.cn/anthropic/v1');
      await protocol.selectOption('chat');
      await expect(endpoint).toHaveValue('https://api.minimax.cn/v1');
      await provider.selectOption('zhipu');
      await expect(endpoint).toHaveValue('https://open.bigmodel.cn/api/paas/v4');
      await protocol.selectOption('messages');
      await page.screenshot({ path: resolve(output, 'zhipu-messages-desktop.png') });
      await save(fixtureNames[0]);
    });
    await test.step('自定义协议不覆盖地址，保存及编辑后配置保留', async () => {
      for (const [name, selectedProtocol] of [[fixtureNames[1], 'chat'], [fixtureNames[2], 'messages']]) {
        await openNew();
        await provider.selectOption('custom');
        await expect(endpoint).toHaveValue('');
        await expect(endpoint).toHaveAttribute('required', '');
        await endpoint.fill('https://compatible.example/tenant/v1');
        await protocol.selectOption('messages');
        await expect(endpoint).toHaveValue('https://compatible.example/tenant/v1');
        await protocol.selectOption('chat');
        await expect(endpoint).toHaveValue('https://compatible.example/tenant/v1');
        await protocol.selectOption(selectedProtocol);
        await save(name);
        await expect(row(name)).toContainText('自定义');
      }
      await page.reload();
      await page.locator('nav').getByRole('button', { name: /^厂商连接/ }).click();
      await row(fixtureNames[2]).getByRole('button', { name: '编辑', exact: true }).click();
      await expect(provider).toHaveValue('custom');
      await expect(protocol).toHaveValue('messages');
      await expect(endpoint).toHaveValue('https://compatible.example/tenant/v1');
      await expect(modal.getByLabel('更换厂商 Token')).toHaveValue('');
      await modal.getByRole('button', { name: '保存连接', exact: true }).click();
      await expect(modal).toHaveCount(0);
    });
    await test.step('厂商手填地址也会保留，并检查桌面、手机和深色表单', async () => {
      await row(fixtureNames[0]).getByRole('button', { name: '编辑', exact: true }).click();
      await endpoint.fill('https://compatible.example/my-plan/v1');
      await protocol.selectOption('chat');
      await expect(endpoint).toHaveValue('https://compatible.example/my-plan/v1');
      await provider.selectOption('custom');
      await expect(endpoint).toHaveValue('https://compatible.example/my-plan/v1');
      for (const [name, width, height, scheme] of [
        ['desktop', 1440, 1000, 'light'], ['mobile', 390, 844, 'light'], ['dark', 1440, 1000, 'dark'],
      ] as const) {
        await page.setViewportSize({ width, height });
        await page.emulateMedia({ colorScheme: scheme });
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
        expect(await modal.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
        await modal.getByRole('button', { name: '保存连接', exact: true }).scrollIntoViewIfNeeded();
        await expect(modal.getByRole('button', { name: '保存连接', exact: true })).toBeInViewport();
        await page.screenshot({ path: resolve(output, 'custom-' + name + '.png') });
      }
      await modal.getByRole('button', { name: '取消', exact: true }).click();
      expect(modelCalls).toBe(0);
    });
  } finally {
    const state = await (await page.request.get('/api/admin/state')).json();
    for (const connection of state.connections.filter((c: { name: string }) => fixtureNames.includes(c.name))) {
      expect((await page.request.delete('/api/admin/connections/' + connection.id, { headers })).status()).toBe(200);
    }
  }
});
