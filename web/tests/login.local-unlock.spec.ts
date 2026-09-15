import { test, expect } from '@playwright/test';

test('本地空白解锁：页面提示、锁定重入、凭证保留和厂商凭证查看', async ({ page }, testInfo) => {
  const password = 'isolated-ui-test-password-2026';
  const headers = { 'X-Gateway-Admin': '1' };
  await page.goto('/');
  await page.getByLabel('管理密码', { exact: true }).fill(password);
  await page.getByLabel('再次输入密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: '创建并进入', exact: true }).click();
  await expect(page.locator('nav')).toBeVisible();
  await page.getByRole('button', { name: '载入本地演示', exact: true }).click();
  const input = page.getByLabel('网关项目凭证');
  await expect(input).toHaveValue(/^gw_[A-Za-z0-9_-]{43}$/);
  const token = await input.inputValue();
  const state = await (await page.request.get('/api/admin/state')).json();
  const project = state.projects[0];
  const connection = await page.request.post('/api/admin/connections', { headers, data: { name: '免密验证连接', provider: 'zhipu', protocol: 'chat', base_url: 'https://upstream.test/v1', token: 'fake-local-passwordless-vendor-key', enabled: true } });
  expect(connection.status()).toBe(200);

  await test.step('直接留空进入，锁定后可重复使用，原项目 Token 不变', async () => {
    await page.getByRole('button', { name: '锁定网关', exact: true }).click();
    const passwordInput = page.getByLabel('管理密码', { exact: true });
    await expect(passwordInput).toHaveValue('');
    await expect(page.locator('.login-card')).toContainText('密码留空即可进入');
    await expect(passwordInput).not.toHaveAttribute('required');
    for (const [name, width, height] of [['desktop', 1440, 1000], ['mobile', 390, 844]] as const) {
      await page.setViewportSize({ width, height });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath('blank-unlock-' + name + '.png') });
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.getByRole('button', { name: '解锁并进入', exact: true }).click();
    await expect(page.locator('nav')).toBeVisible();
    const copied = await page.request.post('/api/admin/projects/' + project.id + '/credential', { headers, data: {} });
    expect(copied.status()).toBe(200);
    expect((await copied.json()).token === token).toBe(true);
    expect((await page.request.get('/v1/models', { headers: { Authorization: 'Bearer ' + token } })).status()).toBe(200);
    await page.getByRole('button', { name: '锁定网关', exact: true }).click();
    await page.reload();
    await expect(passwordInput).toHaveValue('');
    await page.getByRole('button', { name: '解锁并进入', exact: true }).click();
    await expect(page.locator('nav')).toBeVisible();
  });

  await test.step('旧库切换提示保留原密码输入；输入原密码仍可进入', async () => {
    await page.getByRole('button', { name: '锁定网关', exact: true }).click();
    // The real locked-vault transition is verified in the Go integration test.
    await page.route('**/api/status', async route => {
      const response = await route.fetch(); const status = await response.json();
      status.passwordless_ready = false;
      await route.fulfill({ response, json: status });
    });
    await page.reload();
    await expect(page.locator('.login-card')).toContainText('首次切换需输入一次原管理密码');
    await expect(page.getByLabel('管理密码', { exact: true })).toHaveAttribute('required');
    await page.screenshot({ path: testInfo.outputPath('first-unlock-migration.png') });
    await page.unroute('**/api/status');
    await page.getByLabel('管理密码', { exact: true }).fill(password);
    await page.getByRole('button', { name: '解锁并进入', exact: true }).click();
    await expect(page.locator('nav')).toBeVisible();
    const info = await (await page.request.get('/api/status')).json();
    expect(info.passwordless_enabled && info.passwordless_ready).toBe(true);
  });

  await test.step('厂商凭据查看沿用本地空白密码，原值不变', async () => {
    await page.locator('nav').getByRole('button', { name: /^厂商连接/ }).click();
    await page.locator('.connection-card').filter({ hasText: '免密验证连接' }).getByRole('button', { name: '解锁查看', exact: true }).click();
    const modal = page.getByRole('dialog');
    await expect(modal.getByLabel('再次输入管理密码')).toHaveValue('');
    await modal.getByRole('button', { name: '解锁查看', exact: true }).click();
    await expect(modal.locator('.secret')).toHaveText('fake-local-passwordless-vendor-key');
    await modal.getByRole('button', { name: '关闭', exact: true }).click();
  });
});
