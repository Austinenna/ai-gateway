import { test, expect } from '@playwright/test';

test('桌面仅滚动工作区，侧栏和滚动边界固定，窄屏及登录页仍可滚动', async ({ page }, testInfo) => {
  const headers = { 'X-Gateway-Admin': '1' };
  const password = 'isolated-ui-test-password-2026';
  const status = await (await page.request.get('/api/status')).json();
  await page.goto('/');
  await page.getByLabel('管理密码', { exact: true }).fill(password);
  if (!status.configured) await page.getByLabel('再次输入密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: status.configured ? (status.locked ? '解锁并进入' : '进入管理页面') : '创建并进入', exact: true }).click();
  await expect(page.locator('nav')).toBeVisible();
  const create = async (path: string, data: object) => {
    const response = await page.request.post('/api/admin/' + path, { headers, data });
    expect(response.status()).toBe(200);
    return response.json();
  };
  const connection = await create('connections', { name: '滚动检查', provider: 'demo', protocol: 'chat', base_url: 'demo://local', enabled: true });
  const model = await create('models', { name: '滚动演示模型', alias: 'scroll-demo', upstream_model: 'demo', connection_id: connection.id, defaults: {}, enabled: true });
  const project = await create('projects', { name: '滚动演示项目', enabled: true, model_ids: [model.id] });
  const response = await page.request.post('/v1/chat/completions', { headers: { Authorization: 'Bearer ' + project.token }, data: {
    model: model.alias, messages: [{ role: 'user', content: Array.from({ length: 90 }, (_, i) => `第 ${i + 1} 行：这是用于滚动验收的本地演示内容。`).join('\n') }], stream: false,
  } });
  expect(response.status()).toBe(200);
  await page.reload();
  const nav = (name: string) => page.locator('nav').getByRole('button', { name: new RegExp('^' + name) }).click();
  await nav('请求记录');
  await page.locator('.request-item').filter({ hasText: '滚动演示项目' }).first().click();
  await expect(page.locator('.detail-content')).toContainText('第 90 行');
  const workspace = page.getByRole('region', { name: '工作区', exact: true });
  const scrollTop = () => workspace.evaluate(el => el.scrollTop);
  const settleWheel = () => page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))));
  const sidePositions = () => page.locator('.sidebar, .sidebar .brand, .sidebar nav, .sidebar-bottom').evaluateAll(els => els.map(el => {
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  }));
  const checkRoot = async () => {
    expect(await page.evaluate(() => ({ y: scrollY, height: document.documentElement.scrollHeight, viewport: innerHeight }))).toEqual({ y: 0, height: page.viewportSize()!.height, viewport: page.viewportSize()!.height });
  };

  for (const width of [1440, 1024]) {
    await page.setViewportSize({ width, height: 900 });
    await workspace.evaluate(el => el.scrollTop = 0);
    const positions = await sidePositions();
    await page.screenshot({ path: testInfo.outputPath(`scroll-${width}-top.png`) });
    // Use the workspace gutter, outside the long message's own scroll area.
    const maxScroll = await workspace.evaluate(el => el.scrollHeight - el.clientHeight);
    expect(maxScroll).toBeGreaterThan(0);
    await page.mouse.move(width - 20, 560);
    await page.mouse.wheel(0, 650);
    await expect.poll(scrollTop).toBeGreaterThan(Math.min(400, maxScroll - 1));
    expect(await sidePositions()).toEqual(positions);
    await checkRoot();
    await page.screenshot({ path: testInfo.outputPath(`scroll-${width}-middle.png`) });
    const current = await scrollTop();
    await page.mouse.move(80, 550);
    await page.mouse.wheel(0, 600);
    await settleWheel();
    expect(await scrollTop()).toBe(current);
    expect(await sidePositions()).toEqual(positions);
    for (const bottom of [true, false]) {
      await workspace.evaluate((el, end) => el.scrollTop = end ? el.scrollHeight : 0, bottom);
      const boundary = await scrollTop();
      await page.mouse.move(width - 20, 560);
      await page.mouse.wheel(0, bottom ? 1800 : -1800);
      await settleWheel();
      expect(await scrollTop()).toBe(boundary);
      expect(await sidePositions()).toEqual(positions);
      await checkRoot();
    }
    await workspace.focus();
    await page.keyboard.press('PageDown');
    await expect.poll(scrollTop).toBeGreaterThan(0);
  }

  await nav('项目权限');
  await expect.poll(scrollTop).toBe(0);
  await page.locator('.project-row').filter({ hasText: '滚动演示项目' }).getByRole('button', { name: '编辑权限', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('dialog').getByRole('button', { name: '关闭', exact: true }).click();
  await nav('请求记录');
  await page.setViewportSize({ width: 1024, height: 420 });
  await page.getByRole('button', { name: '退出管理', exact: true }).scrollIntoViewIfNeeded();
  await expect(page.getByRole('button', { name: '退出管理', exact: true })).toBeInViewport();
  await checkRoot();
  await page.setViewportSize({ width: 390, height: 844 });
  // Roll over the page margin, outside the request list's own scroll area.
  await page.mouse.move(385, 600);
  await page.mouse.wheel(0, 600);
  await expect.poll(() => page.evaluate(() => scrollY)).toBeGreaterThan(0);
  await page.screenshot({ path: testInfo.outputPath('scroll-mobile.png') });
  await page.setViewportSize({ width: 1024, height: 420 });
  await page.getByRole('button', { name: '退出管理', exact: true }).click();
  await expect(page.locator('.login-page')).toBeVisible();
  await page.mouse.move(900, 300);
  await page.mouse.wheel(0, 500);
  await expect.poll(() => page.evaluate(() => scrollY)).toBeGreaterThan(0);
  await page.getByRole('button', { name: '进入管理页面', exact: true }).scrollIntoViewIfNeeded();
  await expect(page.getByRole('button', { name: '进入管理页面', exact: true })).toBeInViewport();
});
