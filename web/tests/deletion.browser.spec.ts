import { test, expect } from '@playwright/test';

test('配置删除的关联提示、确认取消、错误恢复与历史记录', async ({ page }, testInfo) => {
  const password = 'isolated-ui-test-password-2026';
  const headers = { 'X-Gateway-Admin': '1' };
  const navigate = (name: string) => page.locator('nav').getByRole('button', { name: new RegExp('^' + name) }).click();
  const dialog = (name: string) => page.getByRole('dialog').filter({ has: page.getByRole('heading', { name, exact: true }) });
  const connectionRow = page.locator('.connection-row').filter({ hasText: '删除测试连接' });
  const modelRow = page.getByRole('row').filter({ hasText: '删除测试模型' });
  const projectCard = page.locator('.project-card').filter({ hasText: '删除测试项目' });
  let connectionID = '', modelID = '', projectID = '', token = '';

  await test.step('创建独立的本地模拟配置和项目，通过真实鉴权保存一条请求', async () => {
    const status = await (await page.request.get('/api/status')).json();
    await page.goto('/');
    await page.getByLabel('管理密码', { exact: true }).fill(password);
    if (!status.configured) await page.getByLabel('再次输入密码', { exact: true }).fill(password);
    await page.getByRole('button', { name: status.configured ? (status.locked ? '解锁并进入' : '进入管理页面') : '创建并进入', exact: true }).click();
    await expect(page.locator('nav')).toBeVisible();
    const connection = await page.request.post('/api/admin/connections', { headers, data: { name: '删除测试连接', provider: 'demo', protocol: 'chat', base_url: 'demo://local', enabled: true } });
    expect(connection.status()).toBe(200);
    connectionID = (await connection.json()).id;
    const model = await page.request.post('/api/admin/models', { headers, data: { name: '删除测试模型', alias: 'deletion-flow', connection_id: connectionID, upstream_model: 'local-demo', enabled: true, defaults: {} } });
    expect(model.status()).toBe(200);
    modelID = (await model.json()).id;
    await page.reload();
    await navigate('项目权限');
    await page.getByRole('button', { name: '新建项目', exact: true }).first().click();
    await page.getByLabel('项目名称').fill('删除测试项目');
    await page.getByLabel('删除测试模型').check();
    await page.getByRole('button', { name: '创建并生成凭证', exact: true }).click();
    await dialog('项目凭证已生成').getByRole('button', { name: '用它试调用', exact: true }).click();
    token = await page.getByLabel('网关项目凭证').inputValue();
    await page.getByRole('button', { name: '发送请求', exact: true }).click();
    await expect(page.locator('.call-output')).toContainText('模型授权已通过');
    await expect(page.locator('.request-item').filter({ hasText: '删除测试项目' })).toBeVisible();
    const state = await (await page.request.get('/api/admin/state')).json();
    projectID = state.projects.find((p: { name: string }) => p.name === '删除测试项目').id;
  });

  await test.step('有引用的连接列出模型并提供级联入口，取消不做修改', async () => {
    await navigate('厂商连接');
    await connectionRow.getByRole('button', { name: '删除', exact: true }).click();
    await expect(dialog('删除厂商连接')).toContainText('删除测试模型');
    await expect(dialog('删除厂商连接').getByRole('button', { name: '删除厂商及 1 个模型', exact: true })).toBeEnabled();
    await page.screenshot({ path: testInfo.outputPath('connection-reference.png') });
    await dialog('删除厂商连接').getByRole('button', { name: '取消', exact: true }).click();
    await navigate('模型配置');
    await expect(modelRow).toBeVisible();
  });

  await test.step('编辑窗口可发起删除，取消不删除；确认后移除模型和授权', async () => {
    await modelRow.getByRole('button', { name: '编辑', exact: true }).click();
    await dialog('编辑模型').getByRole('button', { name: '删除模型', exact: true }).click();
    await expect(dialog('删除模型')).toContainText('删除测试项目');
    await expect(dialog('删除模型').getByRole('button', { name: '取消', exact: true })).toBeFocused();
    await dialog('删除模型').getByRole('button', { name: '取消', exact: true }).click();
    await expect(dialog('编辑模型')).toBeVisible();
    const before = await (await page.request.get('/v1/models', { headers: { Authorization: 'Bearer ' + token } })).json();
    expect(before.data.some((m: { id: string }) => m.id === 'deletion-flow')).toBe(true);
    await dialog('编辑模型').getByRole('button', { name: '删除模型', exact: true }).click();
    await dialog('删除模型').getByRole('button', { name: '确认删除', exact: true }).click();
    await expect(modelRow).toHaveCount(0);
    const after = await (await page.request.get('/v1/models', { headers: { Authorization: 'Bearer ' + token } })).json();
    expect(after.data).toEqual([]);
    const state = await (await page.request.get('/api/admin/state')).json();
    expect(state.models.some((m: { id: string }) => m.id === modelID)).toBe(false);
    expect(state.projects.find((p: { id: string }) => p.id === projectID).model_ids).toEqual([]);
  });

  await test.step('删除项目清除暂存凭证，旧凭证失效，历史请求仍可筛选查看', async () => {
    await navigate('项目权限');
    await projectCard.getByRole('button', { name: '编辑权限', exact: true }).click();
    await dialog('编辑项目权限').getByRole('button', { name: '删除项目', exact: true }).click();
    await expect(dialog('删除项目')).toContainText('项目凭证立即失效');
    await page.screenshot({ path: testInfo.outputPath('project-confirmation.png') });
    await dialog('删除项目').getByRole('button', { name: '确认删除', exact: true }).click();
    await expect(projectCard).toHaveCount(0);
    const old = await page.request.get('/v1/models', { headers: { Authorization: 'Bearer ' + token } });
    expect(old.status()).toBe(401);
    await navigate('请求记录');
    await expect(page.getByLabel('网关项目凭证')).toHaveValue('');
    await page.getByLabel('按项目筛选').selectOption(projectID);
    await expect(page.getByLabel('按项目筛选').locator('option:checked')).toHaveText('删除测试项目（已删除）');
    await page.locator('.request-item').filter({ hasText: '删除测试项目' }).click();
    await expect(page.locator('.request-detail')).toContainText('模型授权已通过');
  });

  await test.step('无引用连接允许删除；服务失败保留配置并可重试', async () => {
    await navigate('厂商连接');
    await connectionRow.getByRole('button', { name: '删除', exact: true }).click();
    const url = '**/api/admin/connections/' + connectionID + '?cascade=true';
    await page.route(url, route => route.fulfill({ status: 500, json: { error: { message: '模拟删除失败，请重试' } } }));
    await dialog('删除厂商连接').getByRole('button', { name: '删除厂商连接', exact: true }).click();
    await expect(dialog('删除厂商连接').getByRole('alert')).toContainText('模拟删除失败');
    await expect(connectionRow).toBeVisible();
    await page.unroute(url);
    await dialog('删除厂商连接').getByRole('button', { name: '删除厂商连接', exact: true }).click();
    await expect(connectionRow).toHaveCount(0);
    await page.reload();
    await navigate('厂商连接');
    await expect(connectionRow).toHaveCount(0);
    const state = await (await page.request.get('/api/admin/state')).json();
    expect(state.connections.some((c: { id: string }) => c.id === connectionID)).toBe(false);
    expect(state.request_count).toBeGreaterThan(0);
  });
});
