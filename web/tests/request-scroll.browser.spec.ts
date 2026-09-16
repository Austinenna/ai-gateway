import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  const text = Array.from({ length: 80 }, (_, i) => `第 ${i + 1} 行：验证请求工作台的独立纵向滚动。`).join('\n');
  const record = {
    id: 'scroll-0', project_id: 'p1', project_name: '长名称项目-' + 'long-name-'.repeat(12),
    model_id: 'm1', alias: 'coding-' + 'model-'.repeat(20), upstream_model: 'demo', protocol: 'chat',
    state: 'complete', started: Date.now(), status: 200, duration_ms: 1000, first_text_ms: 100,
    input_tokens: 12, output_tokens: 8, truncated: false,
    input: JSON.stringify({ messages: [{ role: 'user', content: text }] }),
    output: JSON.stringify({ choices: [{ message: { content: text } }] }),
  };
  const records = Array.from({ length: 60 }, (_, i) => ({ ...record, id: `scroll-${i}`, started: record.started - i * 1000 }));
  await page.route('**/api/**', route => {
    const path = new URL(route.request().url()).pathname;
    const json = path === '/api/status' ? { configured: true, authenticated: true, locked: false } :
      path === '/api/admin/state' ? { connections: [], models: [], projects: [], request_count: records.length, dropped_records: 0, base_url: '' } :
      path === '/api/admin/requests' ? records : records.find(r => path === '/api/admin/requests/' + r.id) || {};
    return route.fulfill({ json });
  });
  await page.goto('/');
  await page.locator('nav').getByRole('button', { name: /^请求记录/ }).click();
  await page.locator('.request-item').first().click();
});

test('请求区域禁止横向滚动和回弹，长名称仍完整换行并可纵向滚动', async ({ page }, info) => {
  const list = page.getByRole('region', { name: '请求列表', exact: true });
  const detail = page.getByRole('region', { name: '请求详情', exact: true });
  const workspace = page.getByRole('region', { name: '工作区', exact: true });
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await list.scrollIntoViewIfNeeded();
    await list.evaluate(el => el.scrollTop = 0);
    await expect(list).toHaveCSS('overflow-x', 'hidden');
    await expect(list).toHaveCSS('overscroll-behavior-x', 'none');
    await expect(detail).toHaveCSS('overscroll-behavior-x', 'none');
    const head = await page.locator('.rail-head').boundingBox();
    await list.hover();
    await page.mouse.wheel(600, 400);
    await expect.poll(() => list.evaluate(el => el.scrollTop)).toBeGreaterThan(0);
    expect(await page.locator('.rail-head').boundingBox()).toEqual(head);
    for (const region of [list, detail, workspace]) {
      expect(await region.evaluate(el => ({ left: el.scrollLeft, fits: el.scrollWidth <= el.clientWidth }))).toEqual({ left: 0, fits: true });
    }
    expect(await page.evaluate(() => ({ left: scrollX, fits: document.documentElement.scrollWidth <= innerWidth }))).toEqual({ left: 0, fits: true });
    await page.screenshot({ path: info.outputPath(`vertical-only-${width}.png`), animations: 'disabled' });
  }
});

test('试调用在右侧滚动，开关与长响应都不移动左侧筛选和列表', async ({ page }, info) => {
  const detail = page.getByRole('region', { name: '请求详情', exact: true });
  const list = page.getByRole('region', { name: '请求列表', exact: true });
  const workspace = page.getByRole('region', { name: '工作区', exact: true });
  const toggle = page.getByRole('button', { name: '试调用', exact: true });
  const positions = () => page.locator('.sidebar, .rail-head, .request-rail, .request-items').evaluateAll(els => els.map(el => {
    const { x, y, width, height } = el.getBoundingClientRect();
    return { x, y, width, height, top: el.scrollTop };
  }));
  await detail.getByRole('button', { name: '展开全文', exact: true }).first().click();
  for (const [width, height] of [[1440, 900], [1024, 900], [1024, 420]]) {
    await page.setViewportSize({ width, height });
    await list.evaluate(el => el.scrollTop = 450);
    const before = await positions();
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(detail.locator('.tester form')).toBeVisible();
    await expect(detail.locator('.tester .panel-head')).toBeInViewport();
    expect(await positions()).toEqual(before);
    expect(await detail.evaluate(el => el.scrollTop)).toBe(0);
    await page.screenshot({ path: info.outputPath(`tester-open-${width}-${height}.png`), animations: 'disabled' });
    await detail.hover();
    await page.mouse.wheel(500, 650);
    await expect.poll(() => detail.evaluate(el => el.scrollTop)).toBeGreaterThan(0);
    expect(await positions()).toEqual(before);
    expect(await workspace.evaluate(el => ({ top: el.scrollTop, left: el.scrollLeft }))).toEqual({ top: 0, left: 0 });
    expect(await detail.evaluate(el => ({ left: el.scrollLeft, fits: el.scrollWidth <= el.clientWidth }))).toEqual({ left: 0, fits: true });
    await detail.getByRole('button', { name: '发送请求', exact: true }).scrollIntoViewIfNeeded();
    await expect(detail.getByRole('button', { name: '发送请求', exact: true })).toBeInViewport();
    expect(await positions()).toEqual(before);
    await toggle.click();
    await expect(detail.locator('.tester')).toHaveCount(0);
    expect(await positions()).toEqual(before);
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await toggle.click();
  await list.getByRole('button').nth(3).click();
  await expect(detail.locator('.detail-head')).toBeInViewport();
  await expect(detail.locator('.tester .panel-head')).not.toBeInViewport();
  const listPosition = await list.evaluate(el => el.scrollTop);
  await page.getByRole('button', { name: '关闭试调用', exact: true }).click();
  expect(await list.evaluate(el => el.scrollTop)).toBe(listPosition);
  await page.setViewportSize({ width: 390, height: 844 });
  await toggle.click();
  await expect(detail.locator('.tester .panel-head')).toBeInViewport();
  await detail.getByRole('button', { name: '发送请求', exact: true }).scrollIntoViewIfNeeded();
  await expect(detail.getByRole('button', { name: '发送请求', exact: true })).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath('tester-mobile.png'), animations: 'disabled' });
});
