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
  await setup(page);
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
  await page.getByRole('button', { name: '返回任务', exact: true }).click();
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
