import { test, expect } from '@playwright/test';

const now = Date.now();
const task = (id: string, title: string, at: number) => ({
  id, project_id: 'p1', project_name: '研发助手', grouped: false, title, state: 'done', started: at, updated: at, duration_ms: 1000,
  calls: 1, active: 0, failed: 0, missing_records: 0, input_tokens: 1, output_tokens: 1, input_samples: 1, output_samples: 1, models: ['coding'],
});

test('OBSERVE 各页共用顶栏时间范围：请求、任务、诊断随之筛选', async ({ page }) => {
  const requestQueries: URLSearchParams[] = [];
  const diagnosticWindows: string[] = [];
  await page.route('**/api/**', route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/admin/requests') requestQueries.push(url.searchParams);
    if (url.pathname === '/api/admin/diagnostics') diagnosticWindows.push(url.searchParams.get('window') || '');
    const json = url.pathname === '/api/status' ? { configured: true, authenticated: true, locked: false } :
      url.pathname === '/api/admin/state' ? { connections: [], models: [], projects: [], request_count: 0, dropped_records: 0, base_url: '' } :
      url.pathname === '/api/admin/request-tasks' ? { tasks: [task('t-new', '刚才的任务', now - 60_000), task('t-old', '两天前的任务', now - 2 * 86400e3)] } :
      url.pathname.startsWith('/api/admin/request-tasks/') ? { task: task(url.pathname.split('/').pop()!, '任务详情', now), calls: [], total: 0, has_more: false } :
      url.pathname === '/api/admin/requests' ? { items: [], total: 0 } : {};
    return route.fulfill({ json });
  });
  await page.goto('/?view=requests');
  const range = page.getByRole('group', { name: '总览时间范围' });
  await expect(range.getByRole('button', { name: '24H', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => requestQueries.at(-1)?.has('from')).toBe(true);
  await range.getByRole('button', { name: 'ALL', exact: true }).click();
  await expect.poll(() => requestQueries.at(-1)?.has('from')).toBe(false);

  await page.locator('nav').getByRole('button', { name: /^任务/ }).click();
  await expect(page.locator('.task-item')).toHaveCount(2);
  await range.getByRole('button', { name: '24H', exact: true }).click();
  await expect(page.locator('.task-item')).toHaveCount(1);
  await expect(page.locator('.task-item')).toContainText('刚才的任务');

  await page.locator('nav').getByRole('button', { name: /^异常诊断/ }).click();
  await range.getByRole('button', { name: '7D', exact: true }).click();
  await expect.poll(() => diagnosticWindows.at(-1)).toBe('7d');
});
