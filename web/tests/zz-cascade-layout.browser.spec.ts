import { test, expect } from '@playwright/test';

test('关联模型逐个删除与厂商级联删除，检查桌面和窄屏布局', async ({ page }, testInfo) => {
  test.setTimeout(90_000);
  const headers = { 'X-Gateway-Admin': '1' };
  const password = 'isolated-ui-test-password-2026';
  const nav = (name: string) => page.locator('nav').getByRole('button', { name: new RegExp('^' + name) }).click();
  const modal = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '删除厂商连接', exact: true }) });
  const status = await (await page.request.get('/api/status')).json();
  await page.emulateMedia({ reducedMotion: 'reduce' });
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
  const connection = await create('connections', { name: '智谱 · 开发环境', provider: 'demo', protocol: 'chat', base_url: 'demo://local', enabled: true });
  const models: { id: string; name: string }[] = [];
  const names = ['GLM · 日常对话', 'GLM · 代码助手', 'GLM · 深度思考', '长名称验证：代码审查与技术文档助手（开发环境专用）', 'GLM · 快速摘要', 'GLM · 翻译', 'GLM · 写作', 'GLM · 备用模型'];
  for (let i = 0; i < names.length; i++) models.push(await create('models', {
    name: names[i], alias: i === 3 ? 'development/code-review-and-technical-documentation-assistant' : 'layout-model-' + i,
    upstream_model: i === 3 ? 'example-provider-model-with-an-extremely-long-version-identifier-20260914' : 'example-glm-' + i,
    connection_id: connection.id, enabled: i !== 7, defaults: {},
  }));
  const other = await create('connections', { name: '独立连接', provider: 'demo', protocol: 'chat', base_url: 'demo://local', enabled: true });
  const keep = await create('models', { name: '独立保留模型', alias: 'layout-keep', upstream_model: 'keep', connection_id: other.id, enabled: true, defaults: {} });
  const project = await create('projects', { name: '代码助手项目', enabled: true, model_ids: [...models.map(m => m.id), keep.id] });
  await create('projects', { name: '文档助手', enabled: true, model_ids: models.slice(1, 4).map(m => m.id) });
  await page.reload();

  async function checkLayout() {
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    const overlaps = await page.locator('.model-actions').evaluateAll(groups => groups.some(group => {
      const boxes = [...group.querySelectorAll('button')].map(el => el.getBoundingClientRect());
      return boxes.some((a, i) => boxes.slice(i + 1).some(b => Math.min(a.right, b.right) > Math.max(a.left, b.left) && Math.min(a.bottom, b.bottom) > Math.max(a.top, b.top)));
    }));
    expect(overlaps).toBe(false);
    const clipped = await page.locator('.model-actions').evaluateAll(groups => groups.some(group => {
      const cell = group.parentElement!.getBoundingClientRect();
      return [...group.querySelectorAll('button')].some(el => {
        const box = el.getBoundingClientRect();
        return box.left < cell.left - 1 || box.right > cell.right + 1;
      });
    }));
    expect(clipped).toBe(false);
  }

  await test.step('模型列表在桌面、窄窗口和手机宽度下无溢出或操作重叠', async () => {
    await nav('模型配置');
    for (const [name, width, height] of [['desktop', 1440, 1000], ['compact', 1024, 900], ['mobile', 390, 844]] as const) {
      await page.setViewportSize({ width, height });
      await checkLayout();
      await page.screenshot({ path: testInfo.outputPath('models-' + name + '.png'), fullPage: true });
      if (name === 'mobile') await page.screenshot({ path: testInfo.outputPath('models-mobile-viewport.png') });
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.screenshot({ path: testInfo.outputPath('models-dark.png'), fullPage: true });
    await page.emulateMedia({ colorScheme: 'light' });
    await page.evaluate(() => document.documentElement.style.fontSize = '200%');
    await checkLayout();
    await page.screenshot({ path: testInfo.outputPath('models-text-200.png'), fullPage: true });
    await page.evaluate(() => document.documentElement.style.fontSize = '');
  });

  await test.step('删除窗口直接列出模型和项目，并验证滚动及窄屏按钮可达', async () => {
    await nav('厂商连接');
    await page.locator('.connection-row').filter({ hasText: '智谱 · 开发环境' }).getByRole('button', { name: '删除', exact: true }).click();
    await expect(modal.locator('.linked-model')).toHaveCount(8);
    await expect(modal).toContainText('代码助手项目');
    for (const [name, width, height] of [['desktop', 1440, 1000], ['compact', 1024, 760], ['mobile', 390, 844]] as const) {
      await page.setViewportSize({ width, height });
      await checkLayout();
      await expect(modal.getByRole('button', { name: '删除厂商及 8 个模型', exact: true })).toBeInViewport();
      const bounds = await modal.boundingBox();
      expect(bounds!.x).toBeGreaterThanOrEqual(0);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width + 1);
      await page.screenshot({ path: testInfo.outputPath('cascade-' + name + '.png') });
    }
  });

  await test.step('留在关联列表中单独删除模型，可取消，成功后更新数量', async () => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    const row = modal.locator('.linked-model').filter({ hasText: 'GLM · 日常对话' });
    await row.getByRole('button', { name: '删除模型', exact: true }).click();
    await expect(modal.getByRole('button', { name: '删除厂商及 8 个模型', exact: true })).toBeDisabled();
    await row.getByRole('button', { name: '取消删除此模型', exact: true }).click();
    await expect(row).toBeVisible();
    await row.getByRole('button', { name: '删除模型', exact: true }).click();
    await page.screenshot({ path: testInfo.outputPath('delete-single-model.png') });
    await row.getByRole('button', { name: '确认删除', exact: true }).click();
    await expect(row).toHaveCount(0);
    await expect(modal.locator('.linked-model')).toHaveCount(7);
    await expect(modal.getByRole('button', { name: '删除厂商及 7 个模型', exact: true })).toBeEnabled();
    const state = await (await page.request.get('/api/admin/state')).json();
    expect(state.connections.some((c: { id: string }) => c.id === connection.id)).toBe(true);
    expect(state.projects.find((p: { id: string }) => p.id === project.project.id).model_ids).not.toContain(models[0].id);
  });

  await test.step('一键删除厂商及剩余模型，保留项目、其他连接和模型', async () => {
    await modal.getByRole('button', { name: '删除厂商及 7 个模型', exact: true }).click();
    await expect(modal).toHaveCount(0);
    await expect(page.locator('.connection-row').filter({ hasText: '智谱 · 开发环境' })).toHaveCount(0);
    const state = await (await page.request.get('/api/admin/state')).json();
    expect(state.models.some((m: { connection_id: string }) => m.connection_id === connection.id)).toBe(false);
    expect(state.projects.find((p: { id: string }) => p.id === project.project.id).model_ids).toEqual([keep.id]);
    const list = await page.request.get('/v1/models', { headers: { Authorization: 'Bearer ' + project.token } });
    expect(list.status()).toBe(200);
    expect((await list.json()).data.map((m: { id: string }) => m.id)).toEqual(['layout-keep']);
  });
});
