import { test, expect, type Page } from '@playwright/test';

async function setup(page: Page, count = 4) {
  const grouping = { client: 'workbuddy', root_id: 'root-first', session_id: 'session-same', turn_id: 'turn-first', agent_type: 'main', source: 'root' };
  const base = { project_id: 'p1', project_name: 'WorkBuddy 开发', model_id: 'm1', alias: 'coding', provider: 'zhipu', protocol: 'chat', started: 1800000000000, duration_ms: 1200, first_text_ms: 120, first_token_ms: 100, timing_version: 1, status: 200, state: 'complete', input_tokens: 100, output_tokens: 25, metrics_version: 1, input_total_tokens: 100, output_reported: true, truncated: false, grouping, task_id: 'task-first', input: JSON.stringify({ messages: [{ role: 'user', content: '帮我检查登录流程，并修复重复提交的问题。' }] }), output: JSON.stringify({ choices: [{ message: { content: '已经修复重复提交，并通过登录流程验证。' }, finish_reason: 'stop' }] }) };
  const calls = Array.from({ length: count }, (_, i) => ({ ...base, id: `r-${i}`, started: base.started + i * 2000, grouping: i > 0 && i < count - 1 ? { ...grouping, session_id: 'session-child', parent_session_id: 'session-same', agent_type: 'subagent' } : grouping, state: i === 1 ? 'error' : 'complete', status: i === 1 ? 500 : 200, reply_kind: i === count - 1 ? 'reply' : 'tools' }));
  const first = { id: 'task-first', project_id: 'p1', project_name: base.project_name, grouped: true, title: '帮我检查登录流程，并修复重复提交的问题。', state: 'replied', started: base.started, updated: base.started + count * 2000, duration_ms: count * 2000, calls: count, active: 0, failed: 1, missing_records: 0, input_tokens: count * 100, output_tokens: count * 25, input_samples: count, output_samples: count, question_record_id: 'r-0', reply_record_id: `r-${count - 1}`, grouping, models: ['coding'], providers: ['zhipu'] };
  const second = { ...first, input_samples: 1, output_samples: 1, input_tokens: 100, output_tokens: 25, id: 'task-second', title: '再补充一个回归用例', calls: 1, failed: 0, question_record_id: 'previous', reply_record_id: 'previous', grouping: { ...grouping, root_id: 'root-second', turn_id: 'turn-second' } };
  const legacy = { ...first, input_samples: 1, output_samples: 1, input_tokens: 100, output_tokens: 25, id: 'legacy', grouped: false, title: '历史独立调用', state: 'complete', calls: 1, failed: 0, question_record_id: 'legacy', reply_record_id: 'legacy', grouping: undefined };
  const extra = [{ ...base, id: 'previous', task_id: second.id, grouping: second.grouping, input: JSON.stringify({ messages: [{ role: 'user', content: '再补充一个回归用例' }] }), output: JSON.stringify({ choices: [{ message: { content: '回归用例已添加。' }, finish_reason: 'stop' }] }) }, { ...base, id: 'legacy', task_id: undefined, grouping: undefined }];
  const tasks = [first, second, legacy];
  const all = [...calls, ...extra];
  await page.route('**/api/**', route => {
    const url = new URL(route.request().url()), path = url.pathname;
    let json: unknown = {};
    if (path === '/api/status') json = { configured: true, authenticated: true, locked: false };
    if (path === '/api/admin/state') json = { projects: [{ id: 'p1', name: base.project_name }], models: [], connections: [], request_count: count + 2, dropped_records: 0, base_url: '' };
    if (path === '/api/admin/requests') json = all;
    if (path.startsWith('/api/admin/requests/')) json = all.find(r => r.id === path.split('/').pop());
    if (path === '/api/admin/request-tasks') json = { tasks, recent_call_limit: 200 };
    if (path.startsWith('/api/admin/request-tasks/')) {
      const task = tasks.find(t => t.id === path.split('/').pop())!;
      const records = task.id === first.id ? calls : all.filter(r => r.id === task.question_record_id);
      const offset = Number(url.searchParams.get('offset') || 0);
      json = { task, calls: records.slice(offset, offset + 100), total: records.length, offset, has_more: offset + 100 < records.length };
    }
    return route.fulfill({ json });
  });
  await page.goto('/');
  await page.locator('nav').getByRole('button', { name: /^请求记录/ }).click();
  return { tasks, first, calls };
}

test('WorkBuddy 一次提问汇总，查看子代理与原始调用，保留逐次视图', async ({ page }, info) => {
  const { calls } = await setup(page);
  await expect(page.getByRole('button', { name: '按任务', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.task-item')).toHaveCount(3);
  await expect(page.locator('.task-item').first()).toContainText('4 次调用');
  await expect(page.locator('.task-item').first()).toContainText('1 次调用失败');
  await expect(page.locator('.task-answer')).toContainText('已经修复重复提交');
  await expect(page.locator('.task-stats')).toContainText('400');
  await page.screenshot({ path: info.outputPath('tasks-overview-desktop.png'), fullPage: true, animations: 'disabled' });
  await page.getByRole('button', { name: '调用过程 · 4' }).click();
  await expect(page.locator('.task-call')).toHaveCount(4);
  await expect(page.locator('.task-call').nth(1)).toContainText('子代理');
  await page.locator('.task-call').nth(1).click();
  await expect(page.getByRole('button', { name: '原始数据', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '原始数据', exact: true }).click();
  await expect(page.getByRole('button', { name: '复制项目请求原始数据' })).toBeEnabled();
  await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (value: string) => { (window as unknown as { copied: string }).copied = value; } } }));
  await page.getByRole('button', { name: '复制项目请求原始数据' }).click();
  await expect(page.getByRole('dialog').getByRole('status')).toHaveText('已复制');
  expect(await page.evaluate(() => (window as unknown as { copied: string }).copied)).toBe(calls[1].input);
  await page.getByRole('button', { name: '关闭调用详情', exact: true }).click();
  await page.getByRole('button', { name: '分组信息', exact: true }).click();
  await expect(page.locator('.task-group-fields')).toContainText('root-first');
  await page.locator('.task-item').nth(1).click();
  await expect(page.locator('.task-answer')).toContainText('回归用例已添加');
  await page.getByRole('button', { name: '分组信息', exact: true }).click();
  await expect(page.locator('.task-group-fields')).toContainText('root-second');
  await page.getByRole('button', { name: '逐次调用', exact: true }).click();
  await expect(page.locator('.request-item')).toHaveCount(6);
  await page.locator('.request-item').first().click();
  await expect(page.getByRole('button', { name: '响应详情', exact: true })).toBeVisible();
});

test('任务分页、搜索、独立记录以及窄屏深色布局', async ({ page }, info) => {
  await setup(page, 112);
  await page.getByRole('button', { name: '调用过程 · 112' }).click();
  await expect(page.locator('.task-call')).toHaveCount(100);
  await page.getByRole('button', { name: /加载更多调用/ }).click();
  await expect(page.locator('.task-call')).toHaveCount(112);
  await page.getByRole('button', { name: '对话概览', exact: true }).click();
  for (const [width, height] of [[1440, 900], [1024, 420], [390, 844]]) {
    await page.setViewportSize({ width, height });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
    expect(overflow).toBe(false);
    await page.screenshot({ path: info.outputPath(`task-layout-${width}.png`), fullPage: width === 390, animations: 'disabled' });
  }
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.screenshot({ path: info.outputPath('task-layout-dark-mobile.png'), fullPage: true, animations: 'disabled' });
  await page.getByLabel('搜索任务').fill('再补充');
  await expect(page.locator('.task-item')).toHaveCount(1);
  await page.getByLabel('搜索任务').fill('');
  await page.getByRole('button', { name: '已分组', exact: true }).click();
  await expect(page.locator('.task-item')).toHaveCount(2);
  await page.getByRole('button', { name: '全部', exact: true }).click();
  await page.locator('.task-item').last().click();
  await page.getByRole('button', { name: '分组信息', exact: true }).click();
  await expect(page.locator('.task-group-fields')).toContainText('未分组');
});

test('刷新显示等待后续和未知用量，不声称任务完成', async ({ page }) => {
  const { first } = await setup(page);
  await expect(page.locator('.task-answer')).toContainText('已经修复重复提交');
  first.state = 'waiting'; first.reply_record_id = ''; first.input_samples = 0; first.output_samples = 0;
  await page.getByRole('button', { name: '刷新任务', exact: true }).click();
  await expect(page.locator('.task-head')).toContainText('等待后续');
  await expect(page.locator('.task-answer')).toContainText('尚未记录主代理正常结束的正文回复');
  await expect(page.locator('.task-stats')).toContainText('0 / 4 次用量已知');
  await expect(page.locator('.task-item').first()).toContainText('部分未知');
  await expect(page.locator('.task-stats b').nth(1)).toHaveText('—');
});

test('调用浮层跨分页切换，保留详情页签、背景位置和键盘焦点', async ({ page }) => {
  await setup(page, 112);
  await page.getByRole('button', { name: '调用过程 · 112' }).click();
  const pane = page.getByRole('region', { name: '任务详情', exact: true });
  const trigger = page.locator('.task-call').nth(99);
  await trigger.scrollIntoViewIfNeeded();
  const before = await pane.evaluate(el => el.scrollTop);
  await trigger.click();
  const dialog = page.getByRole('dialog', { name: '单次调用', exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('.detail-request-id')).toHaveText('r-99');
  await expect(dialog.locator('.task-call-dialog-title')).toContainText('第 100 / 112 次调用');
  await dialog.getByRole('button', { name: '原始数据', exact: true }).click();
  await dialog.getByRole('button', { name: '下一个调用', exact: true }).click();
  await expect(dialog.locator('.detail-request-id')).toHaveText('r-100');
  await expect(dialog.getByRole('button', { name: '原始数据', exact: true })).toHaveClass('active');
  await expect(dialog.getByRole('button', { name: '复制项目请求原始数据' })).toBeVisible();
  await dialog.getByRole('button', { name: '上一个调用', exact: true }).click();
  await expect(dialog.locator('.detail-request-id')).toHaveText('r-99');
  expect(await pane.evaluate(el => el.scrollTop)).toBe(before);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
  expect(await pane.evaluate(el => el.scrollTop)).toBe(before);
  await expect(page.locator('.task-call')).toHaveCount(100);
  // The overview reply can point past the first loaded list page.
  await page.getByRole('button', { name: '对话概览', exact: true }).click();
  await page.getByRole('button', { name: '查看响应', exact: true }).click();
  await expect(dialog.locator('.task-call-dialog-title')).toContainText('第 112 / 112 次调用');
  await expect(dialog.locator('.detail-request-id')).toHaveText('r-111');
  await expect(dialog.getByRole('button', { name: '下一个调用', exact: true })).toBeDisabled();
});

test('调用浮层首尾边界、窄屏与深色布局及关闭', async ({ page }, info) => {
  await setup(page);
  await page.getByRole('button', { name: '调用过程 · 4' }).click();
  await page.locator('.task-call').first().click();
  const dialog = page.getByRole('dialog', { name: '单次调用', exact: true });
  const previous = dialog.getByRole('button', { name: '上一个调用', exact: true });
  const next = dialog.getByRole('button', { name: '下一个调用', exact: true });
  await expect(previous).toBeDisabled();
  for (let i = 1; i < 4; i++) {
    await next.click();
    await expect(dialog.locator('.detail-request-id')).toHaveText(`r-${i}`);
  }
  await expect(next).toBeDisabled();
  await previous.click();
  await expect(dialog.locator('.detail-request-id')).toHaveText('r-2');
  for (const [width, height] of [[1440, 900], [1024, 420], [390, 844]]) {
    await page.setViewportSize({ width, height });
    const box = (await dialog.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0); expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(width);
    expect(box.y + box.height).toBeLessThanOrEqual(height);
    expect(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    await expect(previous).toBeInViewport(); await expect(next).toBeInViewport();
    await page.screenshot({ path: info.outputPath(`call-dialog-${width}.png`), animations: 'disabled' });
  }
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.screenshot({ path: info.outputPath('call-dialog-dark.png'), animations: 'disabled' });
  await dialog.getByRole('button', { name: '关闭调用详情', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('button', { name: '调用过程 · 4' })).toHaveClass('active');
});

test('浮层读取失败可重试，快速切换时延迟响应不覆盖当前调用', async ({ page }) => {
  await setup(page);
  let fail = true;
  await page.route('**/api/admin/requests/r-1', route => {
    if (fail) { fail = false; return route.fulfill({ status: 500, json: { error: { message: '模拟读取失败' } } }); }
    return route.fallback();
  });
  await page.route('**/api/admin/requests/r-2', async route => {
    await new Promise(resolve => setTimeout(resolve, 250));
    return route.fallback();
  });
  await page.getByRole('button', { name: '调用过程 · 4' }).click();
  await page.locator('.task-call').nth(1).click();
  const dialog = page.getByRole('dialog', { name: '单次调用', exact: true });
  await expect(dialog.getByRole('alert')).toContainText('模拟读取失败');
  await dialog.getByRole('button', { name: '重试读取调用' }).click();
  await expect(dialog.locator('.detail-request-id')).toHaveText('r-1');
  const delayed = page.waitForResponse('**/api/admin/requests/r-2');
  await dialog.getByRole('button', { name: '下一个调用' }).click();
  await dialog.getByRole('button', { name: '下一个调用' }).click();
  await expect(dialog.locator('.detail-request-id')).toHaveText('r-3');
  await delayed;
  await expect(dialog.locator('.detail-request-id')).toHaveText('r-3');
});
