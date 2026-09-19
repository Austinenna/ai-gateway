import { test, expect } from '@playwright/test';

for (const protocol of ['chat', 'messages']) {
  test(`${protocol} 工具按名称折叠，完整定义可访问并保留未知结构`, async ({ page }, info) => {
    const parameters = { type: 'object', properties: Object.fromEntries(Array.from({ length: 16 }, (_, i) => [`field_${i}`, { type: 'string', description: `参数 ${i}` }])) };
    const definition = { name: 'search', description: '查询本地演示数据', ...(protocol === 'chat' ? { parameters } : { input_schema: parameters }) };
    const named = protocol === 'chat' ? { type: 'function', function: definition } : definition;
    const longName = 'tool_' + 'long_name_'.repeat(20);
    const tools = [named, { name: longName, extra: '<script>unsafe()</script>' }, { type: 'unknown', payload: { keep: true } }, null, 'opaque definition', named];
    const input = JSON.stringify({ messages: [{ role: 'user', content: Array.from({ length: 20 }, (_, i) => `普通消息第 ${i} 行`).join('\n') }], tools });
    const record = { id: 'tools', project_id: 'p', project_name: '工具定义演示', model_id: 'm', alias: 'demo', protocol, started: 1800000000000, duration_ms: 1000, status: 200, state: 'complete', input, output: '{}' };
    const records = [record, { ...record, id: 'other', project_name: '另一条请求' }];
    await page.route('**/api/**', route => {
      const path = new URL(route.request().url()).pathname;
      const json = path === '/api/status' ? { configured: true, authenticated: true, locked: false } : path === '/api/admin/state' ? { connections: [], models: [], projects: [], request_count: 2, dropped_records: 0, base_url: '' } : path === '/api/admin/requests' ? records : records.find(r => path === '/api/admin/requests/' + r.id) || {};
      return route.fulfill({ json });
    });
    await page.goto('/');
    await page.locator('nav').getByRole('button', { name: /^请求记录/ }).click();
    await page.locator('.request-item').filter({ hasText: '工具定义演示' }).click();
    const outer = page.getByRole('button', { name: 'TOOLS · 6 个工具', exact: true });
    const list = page.locator('.tool-definitions');
    const rows = list.locator('details');
    await expect(outer).toBeVisible();
    await expect(rows.locator('summary')).toHaveText(['search', longName, '工具 3', '工具 4', '工具 5', 'search']);
    await expect(list.locator('details[open]')).toHaveCount(0);
    await expect(list.locator('.text-preview, button')).toHaveCount(0);
    await expect(page.locator('.message').first().getByRole('button', { name: '展开全文', exact: true })).toBeVisible();
    await list.scrollIntoViewIfNeeded();
    if (protocol === 'chat') await page.screenshot({ path: info.outputPath('tools-collapsed-desktop.png') });

    await rows.first().locator('summary').focus();
    await rows.first().locator('summary').press('Enter');
    await expect(rows.first()).toHaveAttribute('open', '');
    expect(JSON.parse(await rows.first().locator('pre').textContent() || '')).toEqual(named);
    await expect(rows.first().locator('pre')).toHaveCSS('max-height', 'none');
    await expect(rows.first().locator('pre')).toHaveCSS('overflow-y', 'visible');
    expect(await rows.first().locator('pre').evaluate(el => el.clientHeight)).toBeGreaterThan(500);
    await expect(rows.last().locator('pre')).toBeHidden();
    await outer.click();
    await expect(list).toBeHidden();
    await outer.click();
    await expect(rows.first().locator('pre')).toBeVisible();
    await rows.first().locator('summary').press('Space');
    await expect(rows.first().locator('pre')).toBeHidden();

    for (let i = 1; i < tools.length; i++) {
      await rows.nth(i).locator('summary').click();
      expect(await rows.nth(i).locator('pre').textContent()).toBe(typeof tools[i] === 'string' ? tools[i] : JSON.stringify(tools[i], null, 2));
      await rows.nth(i).locator('summary').click();
    }
    await rows.nth(2).locator('summary').click();
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await outer.scrollIntoViewIfNeeded();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      expect(await list.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
      if (protocol === 'chat') await page.screenshot({ path: info.outputPath(`tools-expanded-${width}.png`), fullPage: width === 390 });
    }
    if (protocol === 'chat') {
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.emulateMedia({ colorScheme: 'dark' });
      await outer.scrollIntoViewIfNeeded();
      await list.screenshot({ path: info.outputPath('tools-dark.png'), animations: 'disabled' });
    }
    await page.locator('.request-item').filter({ hasText: '另一条请求' }).click();
    await expect(list.locator('details[open]')).toHaveCount(0);
    await page.getByRole('button', { name: '原始数据', exact: true }).click();
    expect(JSON.parse(await page.locator('.detail-content pre').first().textContent() || '')).toEqual(JSON.parse(input));
  });
}
