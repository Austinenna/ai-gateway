import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  const record = {
    id: 'timing-new', project_id: 'inspector', project_name: '计时演示', model_id: 'test', alias: 'demo',
    upstream_model: 'demo', protocol: 'chat', started: 1789527606098, duration_ms: 29954,
    timing_version: 1, first_token_ms: 1200, first_text_ms: 25123, status: 200, state: 'complete',
    input_tokens: 12, output_tokens: 8, truncated: false,
    input: JSON.stringify({ messages: [{ role: 'system', content: Array.from({ length: 20 }, (_, i) => `本地模拟指令第 ${i + 1} 行，用于检查长消息折叠。`).join('\n') }, { role: 'user', content: [{ type: 'text', text: '你好\n请用两句话回答。' }] }] }),
    output: JSON.stringify({ choices: [{ message: { content: '你好呀' } }] }),
  };
  const toolOutput = [
    { choices: [{ delta: { reasoning_content: '先读取本地演示文件，' } }] },
    { choices: [{ delta: { reasoning_content: '再根据工具结果继续回答。' } }] },
    { choices: [{ delta: { tool_calls: [
      { index: 0, id: 'call_demo_a', function: { name: 'Read', arguments: '{"file_path":' } },
      { index: 1, id: 'call_demo_b', function: { name: 'Read', arguments: '{"file_path":' } },
      { index: 2, id: 'call_demo_c', function: { name: 'Read', arguments: '{"file_path":' } },
    ] } }] },
    { choices: [{ delta: { tool_calls: [
      { index: 0, function: { arguments: '"/demo/IDENTITY.md"}' } },
      { index: 1, function: { arguments: '"/demo/USER.md"}' } },
      { index: 2, function: { arguments: '"/demo/BOOTSTRAP.md"}' } },
    ] }, finish_reason: 'tool_calls' }] },
  ].map(frame => 'data: ' + JSON.stringify(frame) + '\n\n').join('') + 'data: [DONE]\n\n';
  const records = [record, { ...record, id: 'timing-old', project_name: '旧记录', timing_version: undefined, first_token_ms: undefined },
    { ...record, id: 'timing-empty', project_name: '空响应', first_token_ms: null, first_text_ms: null },
    { ...record, id: 'tools', project_name: '工具调用演示', first_text_ms: null, output: toolOutput },
    { ...record, id: 'preview', project_name: '长消息预览', output: JSON.stringify({ choices: [{ message: { content: Array.from({ length: 40 }, (_, i) => `回答第 ${i + 1} 行：这是用于预览与全文展开验收的本地模拟内容。`).join('\n') } }] }) }];
  await page.route('**/api/**', route => {
    const path = new URL(route.request().url()).pathname;
    const json = path === '/api/status' ? { configured: true, authenticated: true, locked: false } :
      path === '/api/admin/state' ? { connections: [], models: [], projects: [], request_count: records.length, dropped_records: 0, base_url: 'http://127.0.0.1:18318' } :
      path === '/api/admin/requests' ? records : records.find(r => path === '/api/admin/requests/' + r.id);
    return route.fulfill({ json: json ?? {} });
  });
  await page.goto('/');
  await page.locator('nav').getByRole('button', { name: /^请求记录/ }).click();
  await page.locator('.request-item').filter({ hasText: '计时演示' }).click();
});

test('无正文响应提示实际返回内容，详情合并思考与多个工具参数并保留原始数据入口', async ({ page }, testInfo) => {
  await page.locator('.request-item').filter({ hasText: '工具调用演示' }).click();
  await expect(page.locator('.assistant')).toContainText('本次未返回回答正文，已返回思考文本和3 个工具调用');
  await page.getByRole('button', { name: '查看响应详情', exact: true }).click();
  const response = page.locator('.response-details');
  await expect(response.locator('.response-part-thinking')).toContainText('先读取本地演示文件，再根据工具结果继续回答。');
  await expect(response.locator('.response-part-tool')).toHaveCount(3);
  await expect(response.locator('.response-part-tool').nth(0).locator('pre')).toHaveText('{\n  "file_path": "/demo/IDENTITY.md"\n}');
  await expect(response.locator('.response-part-tool').nth(1)).toContainText('/demo/USER.md');
  await expect(response.locator('.response-part-tool').nth(2)).toContainText('/demo/BOOTSTRAP.md');
  await expect(response.locator('.response-finish')).toContainText('tool_calls');
  const thinking = response.locator('.response-part-thinking');
  await thinking.locator('summary').click();
  await expect(thinking.locator('.response-part-body')).toBeHidden();
  await page.screenshot({ path: testInfo.outputPath('response-details-desktop.png'), animations: 'disabled' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: testInfo.outputPath('response-details-mobile.png'), fullPage: true, animations: 'disabled' });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('button', { name: '原始数据', exact: true }).click();
  await expect(page.locator('.detail-content')).toContainText('reasoning_content');
  await page.getByRole('button', { name: '响应详情', exact: true }).click();
  await page.locator('.request-item').filter({ hasText: '计时演示' }).click();
  await expect(page.locator('.detail-head h2')).toHaveText('计时演示');
  await page.getByRole('button', { name: '响应详情', exact: true }).click();
  await expect(page.locator('.response-details .response-part-text')).toContainText('你好呀');
  await expect(page.locator('.response-details .response-part-tool')).toHaveCount(0);
});

test('请求检查器区分首个 token、正文首字及旧记录未采集状态', async ({ page }, testInfo) => {
  await expect(page.locator('.detail-head')).toContainText('首个 Token · TTFT1.2 s');
  await expect(page.locator('.detail-head')).toContainText('正文首字 · TTFC25.12 s');
  await page.getByRole('button', { name: '性能与用量', exact: true }).click();
  await expect(page.locator('.timeline')).toContainText('1.2 s');
  await expect(page.locator('.timeline')).toContainText('25.12 s');
  await page.screenshot({ path: testInfo.outputPath('timing-desktop.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: testInfo.outputPath('timing-mobile.png'), fullPage: true });
  await page.locator('.request-item').filter({ has: page.locator('b', { hasText: /^旧记录$/ }) }).click();
  await expect(page.locator('.detail-head')).toContainText('首个 Token · TTFT未记录');
  await expect(page.locator('.detail-head')).toContainText('正文首字 · TTFC25.12 s');
  await page.locator('.request-item').filter({ hasText: '空响应' }).click();
  await expect(page.locator('.detail-head')).toContainText('首个 Token · TTFT未收到');
});


test('消息块独立折叠、键盘展开及切换请求后恢复默认状态', async ({ page }, testInfo) => {
  const system = page.getByRole('button', { name: 'SYSTEM', exact: true });
  const user = page.getByRole('button', { name: 'USER', exact: true });
  const assistant = page.getByRole('button', { name: 'ASSISTANT · 本次响应', exact: true });
  const blocks = page.locator('.message-content');
  await expect(system).toHaveAttribute('aria-expanded', 'true');
  await system.click();
  await expect(system).toHaveAttribute('aria-expanded', 'false');
  await expect(blocks.nth(0)).toBeHidden();
  await expect(blocks.nth(1)).toBeVisible();
  await expect(blocks.nth(2)).toBeVisible();
  await user.click();
  await expect(blocks.nth(1)).toBeHidden();
  await assistant.click();
  await expect(blocks.nth(2)).toBeHidden();
  await page.screenshot({ path: testInfo.outputPath('messages-collapsed-desktop.png') });
  await assistant.press('Enter');
  await expect(blocks.nth(2)).toBeVisible();
  await expect(blocks.nth(2)).toContainText('你好呀');
  await user.focus();
  await user.press('Space');
  await expect(blocks.nth(1)).toBeVisible();
  await expect(blocks.nth(1)).toContainText('你好');
  await expect(blocks.nth(1).locator('p')).toHaveText('你好\n请用两句话回答。');
  await expect(blocks.nth(1).locator('pre')).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: testInfo.outputPath('messages-mobile.png'), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.locator('.request-item').filter({ has: page.locator('b', { hasText: /^旧记录$/ }) }).click();
  await expect(system).toHaveAttribute('aria-expanded', 'true');
  await expect(blocks.nth(0)).toBeVisible();
  await page.locator('.request-item').filter({ hasText: '计时演示' }).click();
  await expect(system).toHaveAttribute('aria-expanded', 'true');
  await system.click();
  await expect(blocks.nth(0)).toBeHidden();
});

test('长消息预览和全文都随页面滚动，支持键盘展开及切换请求后重置', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.locator('.request-item').filter({ hasText: '长消息预览' }).click();
  await expect(page.locator('.detail-head h2')).toHaveText('长消息预览');
  const detail = page.getByRole('region', { name: '请求详情', exact: true });
  const system = page.locator('.message').first();
  const preview = system.locator('.text-preview-window');
  const toggle = system.getByRole('button', { name: '展开全文', exact: true });
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('.message').nth(1).locator('.text-preview-toggle')).toHaveCount(0);

  const wheelOverText = async () => {
    await preview.evaluate(el => el.scrollIntoView({ block: 'start', behavior: 'instant' }));
    const before = await detail.evaluate(el => el.scrollTop);
    const rect = (await preview.boundingBox())!;
    await page.mouse.move(rect.x + rect.width / 2, Math.max(20, rect.y + 65));
    await page.mouse.wheel(0, 120);
    await expect.poll(() => detail.evaluate(el => el.scrollTop)).toBeGreaterThan(before + 30);
    expect(await preview.evaluate(el => el.scrollTop)).toBe(0);
  };
  await wheelOverText();
  await toggle.focus();
  await toggle.press('Enter');
  await expect(system.getByRole('button', { name: '收起全文', exact: true })).toHaveAttribute('aria-expanded', 'true');
  await expect.poll(() => preview.evaluate(el => el.clientHeight)).toBeGreaterThan(400);
  await wheelOverText();
  await system.getByRole('button', { name: '收起全文', exact: true }).click();
  await expect.poll(() => preview.evaluate(el => el.clientHeight)).toBeLessThan(250);

  const assistant = page.locator('.message.assistant');
  await assistant.getByRole('button', { name: '展开全文', exact: true }).click();
  await expect.poll(() => assistant.locator('.text-preview-window').first().evaluate(el => el.clientHeight)).toBeGreaterThan(800);
  await assistant.getByRole('button', { name: '收起全文', exact: true }).click();
  await assistant.locator('summary').click();
  await expect(assistant.locator('details .text-preview-toggle')).toBeVisible();
  expect(await assistant.locator('details pre').evaluate(el => getComputedStyle(el).overflowY)).toBe('visible');
  await assistant.locator('summary').click();

  await system.getByRole('button', { name: '展开全文', exact: true }).click();
  await page.locator('.request-item').filter({ has: page.locator('b', { hasText: /^旧记录$/ }) }).click();
  await expect(page.locator('.detail-head h2')).toHaveText('旧记录');
  await page.locator('.request-item').filter({ hasText: '长消息预览' }).click();
  await expect(page.locator('.detail-head h2')).toHaveText('长消息预览');
  await expect(system.getByRole('button', { name: '展开全文', exact: true })).toHaveAttribute('aria-expanded', 'false');
  await detail.evaluate(el => el.scrollTop = 0);
  await page.screenshot({ path: testInfo.outputPath('message-preview-desktop.png'), animations: 'disabled' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: testInfo.outputPath('message-preview-mobile.png'), fullPage: true, animations: 'disabled' });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
