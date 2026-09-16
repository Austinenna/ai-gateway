import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  const projects = [{ id: 'p1', name: '研发助手' }, { id: 'p2', name: '文档整理' }];
  const models = [
    { id: 'm1', alias: 'coding', name: '代码助手', connection_id: 'c1' },
    { id: 'm2', alias: 'mini', name: '写作助手', connection_id: 'c2' },
    { id: 'm3', alias: 'custom', name: '自定义模型', connection_id: 'c3' },
  ];
  const connections = [{ id: 'c1', provider: 'zhipu' }, { id: 'c2', provider: 'minimax' }, { id: 'c3', provider: 'custom' }];
  const base = { project_id: 'p1', project_name: '研发助手', model_id: 'm1', alias: 'coding', provider: 'zhipu', state: 'complete', started: Date.now(), status: 200 };
  const records = [
    { ...base, id: 'r0' },
    { ...base, id: 'r1', project_id: 'p2', project_name: '文档整理', model_id: 'm2', alias: 'mini', provider: 'minimax' },
    { ...base, id: 'r2', model_id: 'm2', alias: 'mini', provider: 'minimax', state: 'error', status: 500 },
    { ...base, id: 'r3', model_id: 'deleted-model', provider: 'minimax' },
    { ...base, id: 'r4', alias: 'old-coding' },
    { ...base, id: 'r5', project_id: '', project_name: '未识别项目', model_id: '', alias: 'invalid-alias', provider: '', state: 'rejected', status: 401 },
    { ...base, id: 'r6', project_id: 'p2', project_name: '文档整理', model_id: 'm3', alias: 'custom', provider: 'custom' },
    { ...base, id: 'r7', project_id: 'p2', project_name: '文档整理', provider: undefined },
  ];
  await page.route('**/api/**', route => {
    const path = new URL(route.request().url()).pathname;
    const json = path === '/api/status' ? { configured: true, authenticated: true, locked: false } :
      path === '/api/admin/state' ? { connections, models, projects, request_count: records.length, dropped_records: 0, base_url: '' } :
      path === '/api/admin/requests' ? records : {};
    return route.fulfill({ json });
  });
  await page.goto('/');
  await page.locator('nav').getByRole('button', { name: /^请求记录/ }).click();
});

test('请求筛选菜单支持键盘、取消和窄屏定位', async ({ page }, info) => {
  const project = page.getByRole('combobox', { name: '按项目筛选' });
  await project.focus();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('listbox')).toBeVisible();
  await page.keyboard.press('End');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('Enter');
  await expect(project).toHaveText('文档整理');
  await expect(page.locator('.request-item')).toHaveCount(3);
  await project.click();
  await page.keyboard.press('Home');
  await page.keyboard.press('Escape');
  await expect(project).toHaveText('文档整理');
  await expect(project).toBeFocused();
  await project.click();
  await page.getByRole('option', { name: '所有项目', exact: true }).click();
  await expect(page.locator('.request-item')).toHaveCount(8);
  await project.click();
  await page.getByLabel('搜索请求').click();
  await expect(page.getByRole('listbox')).toHaveCount(0);
  await project.click();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('listbox')).toHaveCount(0);
  for (const [width, height] of [[1440, 900], [1024, 420], [390, 844]]) {
    await page.setViewportSize({ width, height });
    await project.click();
    const box = (await page.getByRole('listbox').boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(width);
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.y + box.height).toBeLessThanOrEqual(height);
    await page.screenshot({ path: info.outputPath(`filter-menu-${width}.png`), fullPage: width === 390, animations: 'disabled' });
    await page.keyboard.press('Escape');
    await page.screenshot({ path: info.outputPath(`filters-${width}.png`), fullPage: width === 390, animations: 'disabled' });
  }
});


test('模型、厂商与项目及状态搜索交叉筛选，保留历史和缺失信息', async ({ page }, info) => {
  const choose = async (kind: string, option: string | RegExp) => {
    await page.getByRole('combobox', { name: `按${kind}筛选` }).click();
    await page.getByRole('option', { name: option, exact: typeof option === 'string' }).click();
  };
  const count = (n: number) => expect(page.locator('.request-item')).toHaveCount(n);
  await choose('厂商', 'MiniMax'); await count(3);
  await choose('项目', '研发助手'); await count(2);
  await choose('模型', /mini.*写作助手/); await count(1);
  await expect(page.locator('.rail-head')).toContainText('1 / 8 条');
  await page.getByRole('button', { name: '完成', exact: true }).click(); await count(0);
  await expect(page.locator('.rail-empty')).toHaveText('没有匹配的请求');
  await page.getByRole('button', { name: '未完成', exact: true }).click(); await count(1);
  await page.getByLabel('搜索请求').fill('r0'); await count(0);
  await page.getByLabel('搜索请求').fill('r2'); await count(1);
  await page.getByRole('button', { name: '刷新请求', exact: true }).click(); await count(1);
  await page.getByRole('button', { name: '清除请求筛选' }).click(); await count(8);
  await expect(page.getByLabel('搜索请求')).toHaveValue('');
  await expect(page.getByRole('button', { name: '全部', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await choose('模型', /coding.*代码助手/); await count(3);
  await expect(page.locator('.request-items')).toContainText('old-coding');
  await choose('厂商', '智谱'); await count(2);
  await choose('厂商', '未记录厂商'); await count(1);
  await choose('模型', '所有模型'); await count(2);
  await choose('厂商', '所有厂商');
  await choose('模型', /coding.*已删除模型/); await count(1);
  await choose('厂商', 'MiniMax'); await count(1);
  await choose('厂商', '智谱'); await count(0);
  await page.getByRole('button', { name: '清除请求筛选' }).click();
  await choose('厂商', '自定义'); await count(1);
  await page.getByRole('button', { name: '清除请求筛选' }).click();
  await choose('项目', '未识别项目'); await count(1);
  await choose('模型', /invalid-alias.*未匹配模型/); await count(1);
  await page.getByRole('button', { name: '清除请求筛选' }).click();
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.getByRole('combobox', { name: '按模型筛选' }).click();
  await page.screenshot({ path: info.outputPath('filters-dark.png'), animations: 'disabled' });
});
