import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  const projects = [{ id: 'p1', name: '研发助手' }, { id: 'p2', name: '文档整理' }];
  const records = projects.map((p, i) => ({ id: `r${i}`, project_id: p.id, project_name: p.name, alias: 'coding', state: 'complete', started: Date.now(), status: 200 }));
  await page.route('**/api/**', route => {
    const path = new URL(route.request().url()).pathname;
    const json = path === '/api/status' ? { configured: true, authenticated: true, locked: false } :
      path === '/api/admin/state' ? { connections: [], models: [], projects, request_count: records.length, dropped_records: 0, base_url: '' } :
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
  await page.keyboard.press('Enter');
  await expect(project).toHaveText('文档整理');
  await expect(page.locator('.request-item')).toHaveCount(1);
  await project.click();
  await page.keyboard.press('Home');
  await page.keyboard.press('Escape');
  await expect(project).toHaveText('文档整理');
  await expect(project).toBeFocused();
  await project.click();
  await page.getByRole('option', { name: '所有项目', exact: true }).click();
  await expect(page.locator('.request-item')).toHaveCount(2);
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
    await page.screenshot({ path: info.outputPath(`filter-menu-${width}.png`), fullPage: width === 390 });
    await page.keyboard.press('Escape');
  }
});
