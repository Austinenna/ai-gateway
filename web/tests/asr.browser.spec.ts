import { test, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

test('百炼 ASR 配置、原生音频调用、项目授权与转写详情', async ({ page, context }) => {
  test.setTimeout(90_000);
  page.setDefaultTimeout(10_000);
  const headers = { 'X-Gateway-Admin': '1' };
  const upstreamCalls: { path?: string; authorization?: string; body: any }[] = [];
  const transcript = '你好，百炼语音转写。';
  const nativeResponse = { output: { text: transcript, sentence: { text: transcript, words: [{ text: '你好', begin_time: 0, end_time: 420 }] } }, usage: { duration: 1.25 }, request_id: 'mock-asr-response' };
  const upstream = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    upstreamCalls.push({ path: req.url, authorization: req.headers.authorization, body: JSON.parse(raw) });
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(nativeResponse));
  });
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const address = upstream.address(); if (!address || typeof address === 'string') throw new Error('mock upstream missing');
  const output = resolve('../output/asr-qa'); mkdirSync(output, { recursive: true });
  const audio = Buffer.from('RIFFmockWAVEfmt mock-asr-audio');
  const dataURI = 'data:audio/wav;base64,' + audio.toString('base64');
  let connectionID = '', modelID = '', projectID = '', deniedProjectID = '';
  try {
    const status = await (await page.request.get('/api/status')).json();
    await page.goto('/');
    await page.getByLabel('管理密码', { exact: true }).fill('isolated-ui-test-password-2026');
    if (!status.configured) await page.getByLabel('再次输入密码', { exact: true }).fill('isolated-ui-test-password-2026');
    await page.getByRole('button', { name: status.configured ? (status.locked ? '解锁并进入' : '进入管理页面') : '创建并进入', exact: true }).click();
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    const modal = page.getByRole('dialog');
    await page.locator('nav').getByRole('button', { name: /^厂商连接/ }).click();
    await page.getByRole('button', { name: '新增连接', exact: true }).first().click();
    await modal.getByRole('combobox', { name: '厂商', exact: true }).selectOption('dashscope');
    await expect(modal.getByRole('checkbox', { name: '百炼 ASR', exact: true })).toBeChecked();
    await expect(modal.getByLabel('百炼 ASR 基础端点')).toHaveValue('https://dashscope.aliyuncs.com/api/v1');
    // Moving from a custom ASR connection to an LLM template must not retain
    // a hidden empty ASR endpoint that makes saving impossible.
    await modal.getByRole('combobox', { name: '厂商', exact: true }).selectOption('custom');
    await modal.getByLabel('百炼 ASR 基础端点').fill('http://127.0.0.1:9/api/v1');
    await modal.getByRole('combobox', { name: '厂商', exact: true }).selectOption('minimax');
    await expect(modal.getByRole('checkbox', { name: 'Chat Completions', exact: true })).toBeChecked();
    await expect(modal.getByLabel('百炼 ASR 基础端点')).toHaveCount(0);
    await modal.getByRole('combobox', { name: '厂商', exact: true }).selectOption('dashscope');
    await modal.getByLabel('连接名称', { exact: true }).fill('百炼 ASR 浏览器验证');
    await modal.getByLabel('百炼 ASR 基础端点').fill(`http://127.0.0.1:${address.port}/api/v1`);
    await modal.getByLabel('厂商 Token').fill('fake-asr-key');
    await modal.getByRole('button', { name: '保存连接', exact: true }).click();
    await expect(modal).toHaveCount(0);
    let state = await (await page.request.get('/api/admin/state')).json();
    connectionID = state.connections.find((c: any) => c.name === '百炼 ASR 浏览器验证').id;
    await page.locator('.connection-row').filter({ hasText: '百炼 ASR 浏览器验证' }).getByRole('button', { name: '编辑', exact: true }).click();
    await expect(modal.getByRole('combobox', { name: '厂商', exact: true })).toHaveValue('dashscope');
    await expect(modal.getByLabel('更换厂商 Token')).toHaveValue('');
    await modal.getByRole('button', { name: '取消', exact: true }).click();

    await page.locator('nav').getByRole('button', { name: /^模型配置/ }).click();
    await page.getByRole('button', { name: '新增模型', exact: true }).first().click();
    await modal.getByRole('combobox', { name: '所属连接', exact: true }).selectOption(connectionID);
    await modal.getByLabel('显示名称').fill('测试语音识别');
    await modal.getByLabel('调用别名').fill('browser-asr');
    await modal.getByLabel('厂商模型 ID').fill('qwen-asr-mock');
    await expect(modal.getByRole('button', { name: '获取模型列表' })).toHaveCount(0);
    await expect(modal.getByLabel('默认 temperature（可选）')).toHaveCount(0);
    await expect(modal.getByLabel('默认 max_tokens（可选）')).toHaveCount(0);
    await modal.getByRole('button', { name: '保存模型', exact: true }).click();
    await expect(modal).toHaveCount(0);
    state = await (await page.request.get('/api/admin/state')).json();
    modelID = state.models.find((m: any) => m.alias === 'browser-asr').id;
    expect(state.models.find((m: any) => m.id === modelID).protocols).toEqual(['dashscope-asr']);

    await page.getByRole('row').filter({ hasText: 'browser-asr' }).getByRole('button', { name: '测试', exact: true }).click();
    await expect(modal.getByRole('button', { name: '发起测试', exact: true })).toBeDisabled();
    await modal.getByLabel('音频文件', { exact: true }).setInputFiles({ name: 'invalid.txt', mimeType: 'text/plain', buffer: audio });
    await expect(modal.getByRole('alert')).toContainText('请选择 MP3');
    await modal.getByLabel('音频文件', { exact: true }).setInputFiles({ name: 'sample.wav', mimeType: 'audio/wav', buffer: audio });
    await modal.getByLabel('热词（可选）').fill('百炼、网关');
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      expect(await modal.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
      await page.screenshot({ path: resolve(output, `asr-test-${width}.png`) });
    }
    await modal.getByRole('button', { name: '发起测试', exact: true }).click();
    await expect(modal.locator('pre')).toHaveText(transcript);
    expect(upstreamCalls).toHaveLength(1);
    expect(upstreamCalls[0]).toMatchObject({ path: '/api/v1/services/aigc/multimodal-generation/generation', authorization: 'Bearer fake-asr-key', body: { model: 'qwen-asr-mock', input: { messages: [{ role: 'system', content: [{ text: '百炼、网关' }] }, { role: 'user', content: [{ audio: dataURI }] }] }, parameters: { format: 'wav', asr_options: { language: 'zh', enable_itn: true } } } });
    expect(upstreamCalls[0].body.stream).toBeUndefined(); expect(upstreamCalls[0].body.max_tokens).toBeUndefined();
    await modal.getByRole('button', { name: '关闭', exact: true }).last().click();

    const projectResponse = await page.request.post('/api/admin/projects', { headers, data: { name: 'ASR 授权验证', enabled: true, model_ids: [modelID] } });
    expect(projectResponse.status()).toBe(200); const project = await projectResponse.json(); projectID = project.project.id;
    const denied = await (await page.request.post('/api/admin/projects', { headers, data: { name: 'ASR 无授权验证', enabled: true, model_ids: [] } })).json(); deniedProjectID = denied.project.id;
    const unauthorized = await page.request.post('/v1/asr/transcriptions', { headers: { Authorization: 'Bearer ' + denied.token }, data: { model: 'browser-asr', input: { messages: [{ role: 'user', content: [{ audio: dataURI }] }] }, parameters: { format: 'wav' } } });
    expect(unauthorized.status()).toBe(403); expect(upstreamCalls).toHaveLength(1);

    await page.reload();
    await page.locator('nav').getByRole('button', { name: /^项目权限/ }).click();
    const row = page.locator('.project-card').filter({ hasText: 'ASR 授权验证' });
    await row.getByRole('button', { name: '接入信息', exact: true }).click();
    await expect(modal.getByRole('combobox', { name: '客户端协议', exact: true })).toHaveValue('dashscope-asr');
    await expect(modal).toContainText('http://127.0.0.1:18318/v1/asr/transcriptions');
    await expect(modal.locator('pre')).toContainText('"model": "browser-asr"');
    await modal.getByRole('button', { name: '复制完整接入配置', exact: true }).click();
    await expect(modal.getByRole('status')).toHaveText('接入配置已复制');
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    expect(copied).toContain('ASR_URL=http://127.0.0.1:18318/v1/asr/transcriptions');
    expect(copied).toContain('Authorization: Bearer ' + project.token);
    expect(copied).toContain('"audio": "data:audio/mp3;base64,');
    await page.screenshot({ path: resolve(output, 'asr-access-mobile.png') });
    await modal.getByRole('button', { name: '关闭', exact: true }).last().click();
    await row.getByRole('button', { name: '试调用', exact: true }).click();
    await modal.getByRole('button', { name: '填入这个项目的凭证', exact: true }).click();
    await page.getByLabel('音频文件', { exact: true }).setInputFiles({ name: 'sample.wav', mimeType: 'audio/wav', buffer: audio });
    await expect(page.getByLabel('消息', { exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: '发送请求', exact: true }).click();
    await expect(page.locator('.call-output')).toHaveText(transcript);
    expect(upstreamCalls).toHaveLength(2); expect(upstreamCalls[1].body.input.messages).toHaveLength(1);
    await page.getByRole('button', { name: '关闭试调用', exact: true }).click();
    await expect(page.locator('.request-item').filter({ hasText: 'ASR 授权验证' })).toBeVisible();
    await page.locator('.request-item').filter({ hasText: 'ASR 授权验证' }).click();
    const detail = page.getByRole('region', { name: '请求详情' });
    await expect(detail.locator('.detail-head')).toContainText('音频时长');
    await expect(detail.locator('.detail-head')).toContainText('1.25');
    await expect(detail.locator('.detail-head')).not.toContainText('Token');
    await detail.getByRole('button', { name: '响应详情', exact: true }).click();
    await expect(detail).toContainText(transcript); await expect(detail).toContainText('begin_time'); await expect(detail).toContainText('420');
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      expect(await detail.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
      await page.screenshot({ path: resolve(output, `asr-response-${width}.png`) });
    }
    await detail.getByRole('button', { name: '性能与用量', exact: true }).click();
    await expect(detail).toContainText('音频用量'); await expect(detail).not.toContainText('Token/s'); await expect(detail).not.toContainText('TTFC');
    await detail.getByRole('button', { name: '原始数据', exact: true }).click();
    await expect(detail).not.toContainText(audio.toString('base64'));
    await expect(detail).toContainText('"format": "wav"');
  } finally {
    await page.evaluate(() => navigator.clipboard.writeText('')).catch(() => {});
    for (const id of [projectID, deniedProjectID].filter(Boolean)) await page.request.delete('/api/admin/projects/' + id, { headers });
    if (modelID) await page.request.delete('/api/admin/models/' + modelID, { headers });
    if (connectionID) await page.request.delete('/api/admin/connections/' + connectionID, { headers });
    await new Promise<void>(resolve => upstream.close(() => resolve()));
  }
});
