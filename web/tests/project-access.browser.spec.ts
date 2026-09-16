import { test, expect } from '@playwright/test';

test('项目接入信息复制、刷新取回、旧 Token 保存与明确重置', async ({ page, context }, testInfo) => {
  test.setTimeout(90_000);
  const headers = { 'X-Gateway-Admin': '1' };
  const password = 'isolated-ui-test-password-2026';
  const status = await (await page.request.get('/api/status')).json();
  await page.goto('/');
  await page.getByLabel('管理密码', { exact: true }).fill(password);
  if (!status.configured) await page.getByLabel('再次输入密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: status.configured ? (status.locked ? '解锁并进入' : '进入管理页面') : '创建并进入', exact: true }).click();
  await expect(page.locator('nav')).toBeVisible();
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const create = async (path: string, data: object) => {
    const response = await page.request.post('/api/admin/' + path, { headers, data });
    expect(response.status()).toBe(200); return response.json();
  };
  const connection = await create('connections', { name: '接入复制演示连接', provider: 'demo', protocol: 'chat', base_url: 'demo://local', enabled: true });
  const model = await create('models', { name: '代码助手', alias: 'coding', upstream_model: 'demo', connection_id: connection.id, defaults: {}, enabled: true });
  const messages = await create('connections', { name: 'Messages 复制演示', provider: 'minimax', protocol: 'messages', base_url: 'https://api.minimax.cn/anthropic/v1', enabled: true, token: 'fake-access-copy-test-secret' });
  const messagesModel = await create('models', { name: '文档助手', alias: 'writing', upstream_model: 'test', connection_id: messages.id, defaults: {}, enabled: true });
  const created = await create('projects', { name: '代码助手 · 开发环境', enabled: true, model_ids: [model.id, messagesModel.id] });
  const projectID = created.project.id;
  const original = created.token;
  const base = '/api/admin/projects/' + projectID;
  const modal = page.getByRole('dialog');
  const openAccess = async () => {
    await page.locator('nav').getByRole('button', { name: /^项目权限/ }).click();
    await page.locator('.project-card').filter({ hasText: '代码助手 · 开发环境' }).getByRole('button', { name: '接入信息', exact: true }).click();
  };
  const clipboard = () => page.evaluate(() => navigator.clipboard.readText());
  let credentialReads = 0;
  page.on('request', r => { if (r.method() === 'POST' && r.url().endsWith(base + '/credential')) credentialReads++; });
  await page.reload();
  await openAccess();

  await test.step('只按需取 Token；复制端点、完整 Token 和按协议匹配的配置', async () => {
    expect(credentialReads).toBe(0);
    await modal.getByRole('button', { name: '复制端点', exact: true }).click();
    await expect(modal.getByRole('status')).toHaveText('网关端点已复制');
    expect(await clipboard()).toBe('http://127.0.0.1:18318/v1');
    expect(credentialReads).toBe(0);
    await modal.getByRole('button', { name: '复制 Token', exact: true }).click();
    await expect(modal.getByRole('status')).toHaveText('完整项目 Token 已复制');
    expect((await clipboard()) === original).toBe(true);
    expect(await modal.evaluate((el, token) => el.textContent!.includes(token), original)).toBe(false);
    await modal.getByRole('button', { name: '复制完整接入配置', exact: true }).click();
    await expect(modal.getByRole('status')).toHaveText('接入配置已复制');
    expect((await clipboard()) === `BASE_URL=http://127.0.0.1:18318/v1\nAPI_KEY=${original}\nMODEL=coding`).toBe(true);
    await modal.getByLabel('客户端协议').selectOption('messages');
    await expect(modal.getByLabel('模型别名 Model')).toHaveValue('writing');
    await modal.getByRole('button', { name: '复制完整接入配置', exact: true }).click();
    await expect(modal.getByRole('status')).toHaveText('接入配置已复制');
    expect((await clipboard()) === `BASE_URL=http://127.0.0.1:18318\nAPI_KEY=${original}\nMODEL=writing`).toBe(true);
    await modal.getByLabel('客户端协议').selectOption('chat');
  });

  async function checkLayout() {
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    expect(await modal.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    expect(await modal.locator('button').evaluateAll(buttons => buttons.some(button => button.scrollWidth > button.clientWidth + 1))).toBe(false);
  }
  await test.step('检查桌面、窄屏、深色及文字放大布局', async () => {
    for (const [name, width, height] of [['desktop', 1440, 1000], ['mobile', 390, 844]] as const) {
      await page.setViewportSize({ width, height });
      await checkLayout();
      await modal.getByRole('button', { name: '复制完整接入配置', exact: true }).scrollIntoViewIfNeeded();
      await expect(modal.getByRole('button', { name: '复制完整接入配置', exact: true })).toBeInViewport();
      await page.screenshot({ path: testInfo.outputPath('project-access-' + name + '.png') });
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.mouse.move(0, 0);
    await page.emulateMedia({ colorScheme: 'dark' });
    await expect(modal.getByRole('button', { name: '复制端点', exact: true })).toHaveCSS('background-color', 'rgb(27, 34, 44)');
    await page.screenshot({ path: testInfo.outputPath('project-access-dark.png') });
    await page.emulateMedia({ colorScheme: 'light' });
    await expect(modal.getByRole('button', { name: '复制端点', exact: true })).toHaveCSS('background-color', 'rgb(255, 255, 255)');
    await page.evaluate(() => document.documentElement.style.fontSize = '200%');
    await checkLayout();
    await page.screenshot({ path: testInfo.outputPath('project-access-text-200.png') });
    await page.evaluate(() => document.documentElement.style.fontSize = '');
  });

  await test.step('刷新与关闭重开后仍可复制原 Token，不发生重置', async () => {
    await page.reload(); await openAccess();
    await modal.getByRole('button', { name: '复制 Token', exact: true }).click();
    await expect(modal.getByRole('status')).toHaveText('完整项目 Token 已复制');
    expect((await clipboard()) === original).toBe(true);
    expect((await page.request.get('/v1/models', { headers: { Authorization: 'Bearer ' + original } })).status()).toBe(200);
    expect(await page.evaluate(() => localStorage.length + sessionStorage.length)).toBe(0);
  });

  await test.step('旧版状态显示保存入口，拒绝不匹配凭证，保存原 Token 不轮换', async () => {
    // Only simulate the legacy list flag; verification and saving use the real API.
    // Actual v2 database upgrade and missing encrypted rows are covered by Go tests.
    await page.route('**/api/admin/state', async route => {
      const response = await route.fetch(); const state = await response.json();
      state.projects.find((p: { id: string }) => p.id === projectID).has_saved_token = false;
      await route.fulfill({ response, json: state });
    });
    await page.reload(); await openAccess();
    await expect(modal.getByRole('button', { name: '复制 Token', exact: true })).toBeDisabled();
    await page.setViewportSize({ width: 390, height: 844 });
    await checkLayout();
    await page.screenshot({ path: testInfo.outputPath('project-access-legacy-mobile.png') });
    await modal.getByLabel('已有项目 Token', { exact: true }).fill('gw_' + 'a'.repeat(43));
    await modal.getByRole('button', { name: '保存已有 Token', exact: true }).click();
    await expect(modal.getByRole('alert')).toContainText('不匹配');
    await page.unroute('**/api/admin/state');
    await modal.getByLabel('已有项目 Token', { exact: true }).fill('  ' + original + '  ');
    await modal.getByRole('button', { name: '保存已有 Token', exact: true }).click();
    await expect(modal).toContainText('已有 Token 已加密保存');
    await expect(modal.getByRole('button', { name: '复制 Token', exact: true })).toBeEnabled();
    expect((await page.request.get('/v1/models', { headers: { Authorization: 'Bearer ' + original } })).status()).toBe(200);
  });

  await test.step('重置有明确确认，取消不影响原 Token，确认后复制新 Token', async () => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await modal.getByRole('button', { name: '重置项目 Token', exact: true }).click();
    await modal.getByRole('button', { name: '取消重置', exact: true }).click();
    expect((await page.request.get('/v1/models', { headers: { Authorization: 'Bearer ' + original } })).status()).toBe(200);
    await modal.getByRole('button', { name: '重置项目 Token', exact: true }).click();
    await modal.getByRole('button', { name: '确认重置 Token', exact: true }).click();
    await expect(modal.getByRole('status')).toContainText('已生成新的 Token');
    await modal.getByRole('button', { name: '复制 Token', exact: true }).click();
    await expect(modal.getByRole('status')).toHaveText('完整项目 Token 已复制');
    const newToken = await clipboard();
    expect(newToken !== original && /^gw_[A-Za-z0-9_-]{43}$/.test(newToken)).toBe(true);
    expect((await page.request.get('/v1/models', { headers: { Authorization: 'Bearer ' + newToken } })).status()).toBe(200);
    expect((await page.request.get('/v1/models', { headers: { Authorization: 'Bearer ' + original } })).status()).toBe(401);
  });
  await test.step('剪贴板不可用时明确提示，按需显示可手动复制内容', async () => {
    await page.evaluate(() => { Object.defineProperty(navigator.clipboard, 'writeText', { configurable: true, value: async () => { throw new Error('Permission denied'); } }); });
    await modal.getByRole('button', { name: '复制 Token', exact: true }).click();
    await expect(modal.getByRole('alert')).toContainText('浏览器未允许复制');
    await expect(modal.getByLabel('待手动复制的内容')).toHaveCount(0);
    await modal.getByRole('button', { name: '显示内容以手动复制', exact: true }).click();
    await expect(modal.getByLabel('待手动复制的内容')).toHaveValue(/^gw_[A-Za-z0-9_-]{43}$/);
    await modal.getByRole('button', { name: '关闭', exact: true }).click();
    await openAccess();
    await expect(modal.getByLabel('待手动复制的内容')).toHaveCount(0);
    await page.evaluate(() => { Reflect.deleteProperty(navigator.clipboard, 'writeText'); });
  });
  // Clear the clipboard and delete only fixtures owned by this test.
  await page.evaluate(() => navigator.clipboard.writeText(''));
  await page.request.delete(base, { headers });
  for (const m of [model, messagesModel]) await page.request.delete('/api/admin/models/' + m.id, { headers });
  for (const c of [connection, messages]) await page.request.delete('/api/admin/connections/' + c.id, { headers });
});
