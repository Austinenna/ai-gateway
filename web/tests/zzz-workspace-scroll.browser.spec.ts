import { test, expect } from '@playwright/test';

test('请求工作台两栏独立滚动、筛选固定、切换重置，手机与试调用保持可用', async ({ page }, testInfo) => {
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
  // Use many isolated records to exercise the list independently of the detail pane.
  let saved: { id: string }[] = [];
  await expect.poll(async () => {
    saved = await (await page.request.get('/api/admin/requests')).json();
    return saved.length;
  }).toBeGreaterThan(0);
  const baseRecord = await (await page.request.get('/api/admin/requests/' + saved[0].id)).json();
  const records = Array.from({ length: 60 }, (_, i) => ({ ...baseRecord, id: 'split-' + i, project_name: '滚动演示项目 ' + (i + 1), started: baseRecord.started - i * 1000 }));
  await page.route('**/api/admin/requests**', route => {
    const path = new URL(route.request().url()).pathname;
    return route.fulfill({ json: path === '/api/admin/requests' ? records : records.find(r => path.endsWith('/' + r.id)) });
  });
  await page.reload();
  const nav = (name: string) => page.locator('nav').getByRole('button', { name: new RegExp('^' + name) }).click();
  await nav('请求记录');
  await page.locator('.request-item').filter({ hasText: '滚动演示项目' }).first().click();
  await expect(page.locator('.detail-content')).toContainText('第 90 行');
  const workspace = page.getByRole('region', { name: '工作区', exact: true });
  const detail = page.getByRole('region', { name: '请求详情', exact: true });
  const list = page.getByRole('region', { name: '请求列表', exact: true });
  const scrollTop = () => detail.evaluate(el => el.scrollTop);
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
    const expand = detail.getByRole('button', { name: '展开全文', exact: true }).first();
    if (await expand.isVisible()) await expand.click();
    await detail.evaluate(el => el.scrollTop = 0);
    await list.evaluate(el => el.scrollTop = 0);
    const positions = await sidePositions();
    const railHead = await page.locator('.rail-head').boundingBox();
    const left = (await page.locator('.request-rail').boundingBox())!;
    const right = (await detail.boundingBox())!;
    expect(left.y).toBe(right.y);
    expect(left.height).toBe(right.height);
    expect(right.y + right.height).toBeLessThan(900);
    await page.screenshot({ path: testInfo.outputPath(`split-${width}-top.png`), animations: 'disabled' });
    const text = (await detail.locator('.text-preview-window').first().boundingBox())!;
    await page.mouse.move(text.x + text.width / 2, Math.min(text.y + 70, right.y + right.height - 30));
    await page.mouse.wheel(0, 650);
    await expect.poll(scrollTop).toBeGreaterThan(400);
    expect(await list.evaluate(el => el.scrollTop)).toBe(0);
    expect(await workspace.evaluate(el => el.scrollTop)).toBe(0);
    expect(await page.locator('.rail-head').boundingBox()).toEqual(railHead);
    expect(await sidePositions()).toEqual(positions);
    await checkRoot();
    await page.screenshot({ path: testInfo.outputPath(`split-${width}-detail-scroll.png`), animations: 'disabled' });

    const current = await scrollTop();
    await list.hover();
    await page.mouse.wheel(0, 500);
    await expect.poll(() => list.evaluate(el => el.scrollTop)).toBeGreaterThan(300);
    expect(await scrollTop()).toBe(current);
    expect(await page.locator('.rail-head').boundingBox()).toEqual(railHead);
    await page.mouse.move(80, 550);
    await page.mouse.wheel(0, 600);
    await settleWheel();
    expect(await scrollTop()).toBe(current);
    expect(await sidePositions()).toEqual(positions);
    for (const bottom of [true, false]) {
      await detail.evaluate((el, end) => el.scrollTop = end ? el.scrollHeight : 0, bottom);
      const boundary = await scrollTop();
      await page.mouse.move(right.x + right.width - 30, right.y + right.height / 2);
      await page.mouse.wheel(0, bottom ? 1800 : -1800);
      await settleWheel();
      expect(await scrollTop()).toBe(boundary);
      expect(await workspace.evaluate(el => el.scrollTop)).toBe(0);
      expect(await sidePositions()).toEqual(positions);
      await checkRoot();
    }
    await detail.focus();
    await page.keyboard.press('PageDown');
    await expect.poll(scrollTop).toBeGreaterThan(0);
  }

  await list.getByRole('button').nth(18).click();
  await expect(page.locator('.detail-head h2')).toHaveText('滚动演示项目 19');
  await expect.poll(scrollTop).toBe(0);
  const listPosition = await list.evaluate(el => el.scrollTop);
  await detail.evaluate(el => el.scrollTop = 120);
  await detail.getByRole('button', { name: '性能与用量', exact: true }).click();
  await expect.poll(scrollTop).toBe(0);
  expect(await list.evaluate(el => el.scrollTop)).toBe(listPosition);

  await page.getByRole('button', { name: '试调用', exact: true }).click();
  await expect(page.locator('.tester form')).toBeVisible();
  await page.getByRole('button', { name: '关闭试调用', exact: true }).click();
  await expect(page.locator('.requests-workspace')).toBeVisible();
  await nav('项目权限');
  await expect.poll(() => workspace.evaluate(el => el.scrollTop)).toBe(0);
  await page.locator('.project-row').filter({ hasText: '滚动演示项目' }).getByRole('button', { name: '编辑权限', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('dialog').getByRole('button', { name: '关闭', exact: true }).click();
  await nav('请求记录');
  await page.setViewportSize({ width: 1024, height: 420 });
  await page.getByRole('button', { name: '退出管理', exact: true }).scrollIntoViewIfNeeded();
  await expect(page.getByRole('button', { name: '退出管理', exact: true })).toBeInViewport();
  await checkRoot();
  const shortPane = (await detail.boundingBox())!;
  expect(shortPane.y + shortPane.height).toBeLessThanOrEqual(420);
  expect(shortPane.height).toBeGreaterThan(200);
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
