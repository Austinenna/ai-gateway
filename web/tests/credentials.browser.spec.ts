import { test, expect } from '@playwright/test';

test('项目试调用的凭证填入、校验、加密取回与退出管理', async ({ page }, testInfo) => {
  const password = 'isolated-ui-test-password-2026';
  const key = page.getByLabel('网关项目凭证');
  const guide = page.getByRole('dialog');
  const openGuide = () => page.getByRole('button', { name: '选择项目并填入', exact: true }).click();
  const send = () => page.getByRole('button', { name: '发送请求', exact: true }).click();
  const headers = { 'X-Gateway-Admin': '1' };
  let originalKey = '', rotatedKey = '', projectID = '', modelID = '';
  let requests = 0;
  page.on('request', r => { if (r.method() === 'POST' && r.url().includes('/v1/')) requests++; });

  await test.step('本地演示生成凭证，关闭重开仍可直接调用', async () => {
    await page.goto('/');
    await page.getByLabel('管理密码', { exact: true }).fill(password);
    await page.getByLabel('再次输入密码', { exact: true }).fill(password);
    await page.getByRole('button', { name: '创建并进入', exact: true }).click();
    await page.getByRole('button', { name: '载入本地演示', exact: true }).click();
    await expect(key).toHaveValue(/^gw_[A-Za-z0-9_-]{43}$/);
    originalKey = await key.inputValue();
    await page.getByRole('button', { name: '关闭试调用', exact: true }).click();
    await page.getByRole('button', { name: '试调用', exact: true }).click();
    await expect.poll(async () => (await key.inputValue()) === originalKey).toBe(true);
    await send();
    await expect(page.locator('.call-output')).toContainText('不会消耗真实额度');
    await expect(page.getByRole('button', { name: '发送请求', exact: true })).toBeEnabled();
    await expect(page.locator('.request-item').first()).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('trial-success.png'), fullPage: true });
    const state = await (await page.request.get('/api/admin/state')).json();
    projectID = state.projects[0].id;
    modelID = state.models[0].id;
  });

  await test.step('误填管理密码、空值或不完整凭证时就地提示，不发送调用', async () => {
    const before = requests;
    for (const [value, message] of [['', '请粘贴完整'], ['admin-password', '不是管理密码'], ['gw_…', '项目凭证不完整']]) {
      await key.fill(value);
      await send();
      await expect(page.getByRole('alert')).toContainText(message);
    }
    expect(requests).toBe(before);
    await openGuide();
    await guide.getByRole('button', { name: '填入这个项目的凭证', exact: true }).click();
    await expect.poll(async () => (await key.inputValue()) === originalKey).toBe(true);
    await key.fill('  ' + originalKey + '\n');
    await send();
    await expect(page.locator('.call-output')).toContainText('模型授权已通过');
    await expect(page.getByRole('button', { name: '发送请求', exact: true })).toBeEnabled();
  });

  await test.step('刷新清除暂存，取回加密凭证不会更换正在使用的 Token', async () => {
    await page.reload();
    await page.locator('nav').getByRole('button', { name: /^请求记录/ }).click();
    await page.getByRole('button', { name: '试调用', exact: true }).click();
    await expect(key).toHaveValue('');
    await openGuide();
    await expect(guide).toContainText('Token 已加密保管');
    await page.screenshot({ path: testInfo.outputPath('credential-recovery.png') });
    await guide.getByRole('button', { name: '填入这个项目的凭证', exact: true }).click();
    await expect.poll(async () => (await key.inputValue()) === originalKey).toBe(true);
    expect((await page.request.get('/v1/models', { headers: { Authorization: 'Bearer ' + originalKey } })).status()).toBe(200);
    await send();
    await expect(page.locator('.call-output')).toContainText('模型授权已通过');
    await expect(page.getByRole('button', { name: '发送请求', exact: true })).toBeEnabled();
    expect(await page.evaluate(() => localStorage.length + sessionStorage.length)).toBe(0);
  });

  await test.step('外部重置后，拒绝旧凭证并重新取回当前有效凭证', async () => {
    const rotate = await page.request.post('/api/admin/projects/' + projectID + '/rotate', { headers, data: {} });
    expect(rotate.status()).toBe(200);
    rotatedKey = (await rotate.json()).token;
    await send();
    await expect(page.getByRole('alert')).toContainText('这份项目凭证已失效');
    await openGuide();
    await guide.getByRole('button', { name: '填入这个项目的凭证', exact: true }).click();
    await expect.poll(async () => (await key.inputValue()) === rotatedKey).toBe(true);
  });

  await test.step('退出后重新登录清除缓存；停用项目引导查看权限', async () => {
    await page.getByRole('button', { name: '退出管理', exact: true }).click();
    await page.getByLabel('管理密码', { exact: true }).fill(password);
    await page.getByRole('button', { name: '进入管理页面', exact: true }).click();
    await expect(key).toHaveValue('');
    await openGuide();
    await expect(guide.getByRole('button', { name: '填入这个项目的凭证', exact: true })).toBeVisible();
    await guide.getByRole('button', { name: '填入这个项目的凭证', exact: true }).click();
    await expect.poll(async () => (await key.inputValue()) === rotatedKey).toBe(true);
    const disabled = await page.request.put('/api/admin/projects/' + projectID, { headers, data: { name: '演示项目', enabled: false, model_ids: [modelID] } });
    expect(disabled.ok()).toBe(true);
    await page.reload();
    await page.getByRole('button', { name: '项目权限', exact: true }).click();
    await page.locator('.project-card').getByRole('button', { name: '试调用', exact: true }).click();
    await expect(guide).toContainText('此项目已停用');
    await expect(guide.getByRole('button', { name: '重置凭证并填入', exact: true })).toHaveCount(0);
    await guide.getByRole('button', { name: '查看项目权限', exact: true }).click();
    await expect(guide.getByRole('heading', { level: 2 })).toHaveText('编辑项目权限');
  });
});
