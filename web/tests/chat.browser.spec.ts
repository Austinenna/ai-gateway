import { test, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

test('对话调试贯通双协议、多轮、临时参数、取消、重试和请求记录', async ({ page }) => {
  test.setTimeout(100_000);
  page.setDefaultTimeout(10_000);
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const headers = { 'X-Gateway-Admin': '1' };
  const calls: { path: string; body: any }[] = [];
  const attempts = new Map<string, number>();
  let canceled = 0;
  const thinking = '仅用于测试的上游思考内容。';
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); calls.push({ path: req.url || '', body });
    const question = body.messages.at(-1).content;
    attempts.set(question, (attempts.get(question) || 0) + 1);
    if (question === '故障重试' && attempts.get(question) === 1) {
      res.writeHead(429, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { message: '模拟上游限流，请稍后重试。' } })); return;
    }
    const messages = req.url === '/messages';
    const answer = question === '测试第一轮' ? '第一轮回答：你好🙂。' : question === '继续说明' ? '第二轮回答：已收到上下文。' : '模拟回答：' + question;
    if (!body.stream) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(messages ? { content: [{ type: 'thinking', thinking }, { type: 'text', text: answer }], stop_reason: 'end_turn', usage: { input_tokens: 12, output_tokens: 5 } } : { choices: [{ message: { content: answer, reasoning_content: thinking }, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 5 } })); return;
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const event = (value: any) => res.write('data: ' + JSON.stringify(value) + '\n\n');
    if (question === '慢速回答') {
      event(messages ? { type: 'content_block_delta', delta: { type: 'text_delta', text: '已经收到的部分内容' } } : { choices: [{ delta: { content: '已经收到的部分内容' } }] });
      const timer = setTimeout(() => res.end(), 20_000);
      res.on('close', () => { canceled++; clearTimeout(timer); }); return;
    }
    if (question === '中途断开') {
      event(messages ? { type: 'content_block_delta', delta: { type: 'text_delta', text: '断开前的正文' } } : { choices: [{ delta: { content: '断开前的正文' } }] });
      res.end(); return;
    }
    if (messages) {
      event({ type: 'message_start', message: { content: [], usage: { input_tokens: 12, output_tokens: 0 } } });
      event({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking } });
      event({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } });
      event({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: answer } });
      event({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } });
      event({ type: 'message_stop' });
    } else {
      event({ choices: [{ index: 0, delta: { reasoning_content: thinking } }] });
      event({ choices: [{ index: 0, delta: { content: answer } }] });
      event({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 5 } });
      res.write('data: [DONE]\n\n');
    }
    res.end();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('missing mock address');
  const endpoint = `http://127.0.0.1:${address.port}`;
  const modelIDs: string[] = []; let connectionID = '';
  const output = resolve('../output/chat-qa'); mkdirSync(output, { recursive: true });
  try {
    const status = await (await page.request.get('/api/status')).json();
    await page.goto('/');
    await page.getByLabel('管理密码', { exact: true }).fill('isolated-ui-test-password-2026');
    if (!status.configured) await page.getByLabel('再次输入密码', { exact: true }).fill('isolated-ui-test-password-2026');
    await page.getByRole('button', { name: status.configured ? (status.locked ? '解锁并进入' : '进入管理页面') : '创建并进入', exact: true }).click();
    await expect(page.locator('nav').getByRole('button', { name: '对话调试', exact: true })).toBeVisible();
    const c = await page.request.post('/api/admin/connections', { headers, data: { name: '本地对话测试连接', provider: 'custom', endpoints: { chat: endpoint, messages: endpoint, 'dashscope-asr': endpoint }, token: 'fake-chat-browser-key', enabled: true } });
    expect(c.ok(), await c.text()).toBe(true); connectionID = (await c.json()).id;
    for (const [name, alias, protocols, enabled, max_tokens] of [
      ['对话测试 A', 'chat-ui-a', ['chat', 'messages'], true, 512],
      ['对话测试 B', 'chat-ui-b', ['messages'], true, 768],
      ['不可选的语音模型', 'chat-ui-asr', ['dashscope-asr'], true, undefined],
      ['不可选的停用模型', 'chat-ui-disabled', ['chat'], false, 100],
    ] as const) {
      const response = await page.request.post('/api/admin/models', { headers, data: { name, alias, protocols, enabled, connection_id: connectionID, upstream_model: alias + '-upstream', defaults: max_tokens ? { temperature: 0.7, max_tokens } : {} } });
      expect(response.ok(), await response.text()).toBe(true); modelIDs.push((await response.json()).id);
    }
    await page.reload();
    const nav = page.locator('nav');
    await nav.getByRole('button', { name: '对话调试', exact: true }).click();
    const chat = page.locator('.chat-page');
    const model = chat.getByLabel('对话模型', { exact: true });
    await model.selectOption(modelIDs[0]);
    await expect(model.locator('option').filter({ hasText: '不可选的语音模型' })).toHaveCount(0);
    await expect(model.locator('option').filter({ hasText: '不可选的停用模型' })).toHaveCount(0);
    await expect(chat.locator('.chat-panel')).toHaveCount(0);
    const settings = chat.locator('.chat-toolbar-actions').getByRole('button', { name: /^参数/ });
    await settings.click();
    await chat.getByLabel(/^系统提示词/).fill('请简洁回答。');
    await chat.getByLabel('对话 Temperature', { exact: true }).fill('0');
    await chat.getByLabel('对话最大输出', { exact: true }).fill('32');
    await chat.getByRole('button', { name: '应用参数', exact: true }).click();
    await settings.click(); await expect(chat.locator('.chat-panel')).toHaveCount(0);
    await settings.click(); await expect(chat.getByLabel('对话 Temperature', { exact: true })).toHaveValue('0');
    await settings.click();
    async function send(question: string) {
      await chat.getByLabel('对话消息输入', { exact: true }).fill(question);
      await chat.getByRole('button', { name: '发送', exact: true }).click();
    }
    const draft = chat.getByLabel('对话消息输入', { exact: true });
    await draft.fill('测试第一轮');
    await draft.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', isComposing: true });
    await draft.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 229, isComposing: false });
    expect(calls).toHaveLength(0);
    await draft.press('Shift+Enter');
    await expect(draft).toHaveValue('测试第一轮\n');
    expect(calls).toHaveLength(0);
    await draft.press('Enter');
    await expect(chat.locator('.chat-message-assistant .chat-message-text')).toHaveText('第一轮回答：你好🙂。');
    await expect(chat.getByRole('button', { name: '停止生成', exact: true })).toHaveCount(0);
    await expect(chat.locator('.chat-message-metrics')).toContainText('Token 12 → 5');
    expect(calls[0]).toMatchObject({ path: '/chat/completions', body: { model: 'chat-ui-a-upstream', temperature: 0, max_tokens: 32, stream: true, messages: [{ role: 'system', content: '请简洁回答。' }, { role: 'user', content: '测试第一轮' }] } });
    await model.selectOption(modelIDs[1]);
    await expect(chat.getByLabel('对话协议', { exact: true })).toHaveCount(0);
    await send('继续说明');
    await expect(chat.locator('.chat-message-assistant .chat-message-text').last()).toHaveText('第二轮回答：已收到上下文。');
    await expect(chat.getByRole('button', { name: '停止生成', exact: true })).toHaveCount(0);
    expect(calls[1]).toMatchObject({ path: '/messages', body: { model: 'chat-ui-b-upstream', system: '请简洁回答。', temperature: 0, max_tokens: 32, messages: [{ role: 'user', content: '测试第一轮' }, { role: 'assistant', content: '第一轮回答：你好🙂。' }, { role: 'user', content: '继续说明' }] } });
    expect(JSON.stringify(calls[1].body)).not.toContain(thinking);
    await expect(chat.locator('.chat-message-assistant').first().locator('.chat-message-heading')).toContainText('对话测试 A');
    await chat.getByRole('button', { name: '请求详情', exact: true }).first().click();
    await expect(chat.locator('.chat-request-meta')).toContainText('chat-ui-a');
    await expect(chat.locator('.chat-raw')).toContainText('测试第一轮');
    await expect(chat.locator('.chat-raw')).not.toContainText('继续说明');
    await chat.getByRole('tab', { name: '响应原文', exact: true }).click();
    await expect(chat.locator('.chat-raw')).toContainText('第一轮回答');
    await chat.getByRole('button', { name: '在请求记录中查看', exact: true }).click();
    await expect(page.locator('.detail-head h2')).toHaveText('对话调试');
    await nav.getByRole('button', { name: '对话调试', exact: true }).click();
    await expect(chat.locator('.chat-message')).toHaveCount(4);
    await chat.getByRole('button', { name: '新对话', exact: true }).click();
    await expect(model).toHaveValue(modelIDs[1]);
    await send('慢速回答');
    await expect(chat.locator('.chat-message-assistant .chat-message-text')).toHaveText('已经收到的部分内容');
    await chat.getByRole('button', { name: '停止生成', exact: true }).click();
    await expect(chat.locator('.chat-message-state')).toHaveText('已停止');
    await expect.poll(() => canceled).toBe(1);
    await expect(chat.locator('.chat-message-assistant .chat-message-text')).toHaveText('已经收到的部分内容');
    await chat.getByRole('button', { name: '新对话', exact: true }).click();
    await send('故障重试');
    await expect(chat.getByRole('alert')).toContainText('模拟上游限流');
    await chat.getByRole('button', { name: '重试', exact: true }).click();
    await expect(chat.locator('.chat-message-assistant .chat-message-text')).toHaveText('模拟回答：故障重试');
    await expect(chat.locator('.chat-message-user')).toHaveCount(1);
    expect(calls.at(-1)!.body.messages).toEqual([{ role: 'user', content: '故障重试' }]);
    await chat.getByRole('button', { name: '新对话', exact: true }).click();
    await send('中途断开');
    await expect(chat.getByRole('alert')).toContainText('完整结束前断开');
    await expect(chat.locator('.chat-message-state')).toHaveText('未完整结束');
    await chat.getByRole('button', { name: '新对话', exact: true }).click();
    await settings.click();
    await chat.getByRole('button', { name: '恢复默认', exact: true }).click();
    await chat.getByRole('checkbox', { name: '流式输出', exact: true }).uncheck();
    await chat.getByRole('button', { name: '应用参数', exact: true }).click();
    await send('非流式测试');
    await expect(chat.locator('.chat-message-assistant .chat-message-text')).toHaveText('模拟回答：非流式测试');
    await expect(chat.locator('.chat-message-metrics')).toContainText('首 Token 非流式');
    expect(calls.at(-1)!.body).toMatchObject({ stream: false, max_tokens: 768, temperature: 0.7 });
    expect(calls.at(-1)!.body.system).toBeUndefined();
    const state = await (await page.request.get('/api/admin/state')).json();
    expect(state.models.find((item: any) => item.id === modelIDs[0]).defaults).toEqual({ temperature: 0.7, max_tokens: 512 });
    for (const width of [1440, 1024, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      await expect(chat.locator('.chat-settings')).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      if (width >= 1024) {
        const box = await chat.locator('.chat-composer').boundingBox(); expect(box!.y + box!.height).toBeLessThanOrEqual(1000);
      }
      await page.screenshot({ path: resolve(output, `chat-${width}.png`), fullPage: width === 390 });
    }
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.screenshot({ path: resolve(output, 'chat-mobile-dark.png'), fullPage: true, animations: 'disabled' });
    await settings.click(); await expect(chat.locator('.chat-panel')).toHaveCount(0);
    await settings.click(); await expect(chat.locator('.chat-settings')).toBeVisible();
    await page.setViewportSize({ width: 1280, height: 1000 });
    await page.reload(); await nav.getByRole('button', { name: '对话调试', exact: true }).click();
    await expect(chat.locator('.chat-message')).toHaveCount(0);
    await model.selectOption(modelIDs[1]);
    await send('慢速回答');
    await expect(chat.locator('.chat-message-assistant .chat-message-text')).toHaveText('已经收到的部分内容');
    await page.getByRole('button', { name: '退出管理', exact: true }).click();
    await expect(page.getByLabel('管理密码', { exact: true })).toBeVisible();
    await expect.poll(() => canceled).toBe(2);
    await page.getByLabel('管理密码', { exact: true }).fill('isolated-ui-test-password-2026');
    await page.getByRole('button', { name: '进入管理页面', exact: true }).click();
    await nav.getByRole('button', { name: '对话调试', exact: true }).click();
    await expect(chat.locator('.chat-message')).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally {
    for (const id of modelIDs) await page.request.delete('/api/admin/models/' + id, { headers }).catch(() => {});
    if (connectionID) await page.request.delete('/api/admin/connections/' + connectionID, { headers }).catch(() => {});
    await new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); });
  }
});

test('空配置可直接打开对话页并引导配置模型', async ({ page }) => {
  await page.route('**/api/**', route => {
    const path = new URL(route.request().url()).pathname;
    return route.fulfill({ json: path === '/api/status' ? { configured: true, authenticated: true, locked: false } : path === '/api/admin/state' ? { connections: [], models: [], projects: [], request_count: 0, dropped_records: 0, base_url: 'http://127.0.0.1:18318' } : path === '/api/admin/request-tasks' ? { tasks: [] } : [] });
  });
  await page.goto('/?view=chat');
  await expect(page.getByRole('heading', { name: '对话调试', exact: true })).toBeVisible();
  await expect(page.getByLabel('对话模型', { exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: '发送', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '去配置模型', exact: true }).click();
  await expect(page.getByRole('heading', { name: '模型配置', exact: true })).toBeVisible();
});
