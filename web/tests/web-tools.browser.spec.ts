import { test, expect } from '@playwright/test';

test('DeepSeek 搜索与抓取：连接模板、默认不勾选、单独建模型并测试', async ({ page }) => {
  const password = 'isolated-ui-test-password-2026';
  const status = await (await page.request.get('/api/status')).json();
  await page.goto('/');
  await page.getByLabel('管理密码', { exact: true }).fill(password);
  if (!status.configured) await page.getByLabel('再次输入密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: status.configured ? (status.locked ? '解锁并进入' : '进入管理页面') : '创建并进入', exact: true }).click();
  const modal = page.getByRole('dialog');
  const box = (name: string) => modal.getByRole('checkbox', { name, exact: true });

  await test.step('DeepSeek 连接预填两个搜索端点', async () => {
    await page.locator('nav').getByRole('button', { name: /^厂商连接/ }).click();
    await page.getByRole('button', { name: '新增连接', exact: true }).first().click();
    await modal.getByRole('combobox', { name: '厂商', exact: true }).selectOption('deepseek');
    await box('DeepSeek 搜索').check();
    await box('DeepSeek 抓取').check();
    await expect(modal.getByLabel('DeepSeek 搜索 基础端点')).toHaveValue('https://api.deepseek.com/v1');
    await expect(modal.getByLabel('DeepSeek 抓取 基础端点')).toHaveValue('https://api.deepseek.com/v1');
    await modal.getByLabel('连接名称', { exact: true }).fill('DeepSeek 搜索验证');
    await modal.getByLabel('厂商 Token').fill('fake-deepseek-key');
    await modal.getByRole('button', { name: '保存连接', exact: true }).click();
    await expect(modal).toHaveCount(0);
  });

  await test.step('新建模型默认不勾选搜索；只勾搜索时不显示模型目录和默认参数', async () => {
    const state = await (await page.request.get('/api/admin/state')).json();
    const connection = state.connections.find((c: { name: string }) => c.name === 'DeepSeek 搜索验证');
    await page.locator('nav').getByRole('button', { name: /^模型配置/ }).click();
    await page.getByRole('button', { name: '新增模型', exact: true }).first().click();
    await modal.getByRole('combobox', { name: '所属连接', exact: true }).selectOption(connection.id);
    await expect(box('Chat Completions')).toBeChecked();
    await expect(box('DeepSeek 搜索')).not.toBeChecked();
    await expect(box('DeepSeek 抓取')).not.toBeChecked();
    await box('Chat Completions').uncheck();
    await box('DeepSeek 搜索').check();
    await box('DeepSeek 抓取').check();
    await expect(modal.getByLabel('默认 temperature（可选）')).toHaveCount(0);
    await modal.getByLabel('显示名称').fill('联网搜索');
    await modal.getByLabel('调用别名').fill('web-search-ui');
    await modal.getByLabel('上游模型 ID（不会发送）').fill('deepseek-web-tools');
    await modal.getByRole('button', { name: '保存模型', exact: true }).click();
    await expect(modal).toHaveCount(0);
  });

  await test.step('测试搜索协议，显示可读结果', async () => {
    const state = await (await page.request.get('/api/admin/state')).json();
    const model = state.models.find((m: { alias: string }) => m.alias === 'web-search-ui');
    expect(model.protocols).toEqual(['deepseek-search', 'deepseek-fetch']);
    let sent: unknown;
    await page.route('**/api/admin/models/' + model.id + '/test', async route => {
      sent = route.request().postDataJSON();
      await route.fulfill({ json: { results: [{ title: 'Search & Fetch', url: 'https://api-docs.deepseek.com/guides/search/' }] } });
    });
    await page.getByRole('row').filter({ hasText: 'web-search-ui' }).getByRole('button', { name: '测试', exact: true }).click();
    await modal.getByRole('combobox', { name: '测试协议', exact: true }).selectOption('deepseek-search');
    await modal.getByRole('button', { name: '发起测试', exact: true }).click();
    await expect(modal.locator('pre')).toContainText('1. Search & Fetch');
    expect(sent).toEqual({ protocol: 'deepseek-search' });
  });
});
