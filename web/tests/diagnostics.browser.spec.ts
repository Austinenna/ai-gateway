import { test, expect } from '@playwright/test';

test('异常与诊断聚合锁定错误并跳转代表请求', async ({ page }) => {
  const diagnostic = {
    code: 'gateway_locked', message: '网关已锁定，请在管理页面解锁', phase: 'unlock', source: 'gateway',
    upstream_contacted: false, retryable: true, recommended_action: 'admin_login',
  };
  const record = {
    id: 'locked-request', project_id: 'p1', project_name: 'OpenClaw', model_id: 'm1', alias: 'MiniMax-M3',
    connection_id: 'c1', connection_name: 'minimax', upstream_model: 'MiniMax-M3', provider: 'minimax', protocol: 'messages',
    started: Date.now() - 60000, duration_ms: 5, first_token_ms: null, first_text_ms: null,
    status: 503, upstream_status: 0, state: 'error', error_type: 'gateway_error', input_tokens: 0, output_tokens: 0,
    truncated: false, diagnostic, input: '', output: '',
  };
  const diagnostics = {
    from: Date.now() - 86400000, to: Date.now(), monitoring_since: Date.now() - 86400000,
    summary: { requests: 3, failed: 2, active: 0, groups: 1, errors: { gateway_locked: 2 }, latest_failure: record.started },
    groups: [{ code: 'gateway_locked', message: diagnostic.message, phase: 'unlock', source: 'gateway', status: 503, error_type: 'gateway_error', upstream_status: 0, count: 2, first_started: record.started - 1000, last_started: record.started, retryable: true, upstream_contacted: false, recommended_action: 'admin_login', example_id: record.id, models: ['MiniMax-M3'], providers: ['minimax'], protocols: ['messages'], projects: ['OpenClaw'] }],
    recent: [record], options: { codes: [{ id: 'gateway_locked', name: diagnostic.message }], providers: [{ id: 'minimax', name: 'minimax' }], protocols: [{ id: 'messages', name: 'messages' }], models: [{ id: 'm1', name: 'MiniMax-M3' }], projects: [{ id: 'p1', name: 'OpenClaw' }] },
    runtime: { configured: true, locked: true, service_auto_unlock: true, monitoring_since: Date.now() - 86400000 }, metrics_errors: 0, dropped_records: 0,
  };
  await page.route('**/api/**', route => {
    const path = new URL(route.request().url()).pathname;
    const json = path === '/api/status' ? { configured: true, authenticated: true, locked: true } :
      path === '/api/admin/state' ? { connections: [{ id: 'c1', name: 'minimax', provider: 'minimax', enabled: true }], models: [{ id: 'm1', alias: 'MiniMax-M3', connection_id: 'c1', enabled: true }], projects: [{ id: 'p1', name: 'OpenClaw', enabled: true, model_ids: ['m1'] }], request_count: 2, dropped_records: 0, base_url: 'http://127.0.0.1:8317/v1' } :
      path === '/api/admin/request-tasks' ? { tasks: [] } :
      path === '/api/admin/diagnostics' ? diagnostics :
      path === '/api/admin/requests' ? [record] :
      path === '/api/admin/requests/locked-request' ? record : {};
    return route.fulfill({ json });
  });
  await page.goto('/');
  await page.getByRole('button', { name: /^异常诊断/ }).click();
  await expect(page.getByRole('heading', { name: '异常诊断', level: 1 })).toBeVisible();
  await page.getByRole('button', { name: /错误明细/ }).click();
  await expect(page.locator('.diagnostic-runtime-card.locked')).toContainText('已锁定');
  await expect(page.locator('.diagnostic-group-list')).toContainText('网关已锁定，请在管理页面解锁');
  await expect(page.locator('.diagnostic-detail')).toContainText('没有到达上游');
  await page.getByRole('button', { name: '查看代表请求', exact: false }).click();
  await expect(page.locator('.request-diagnostic-note')).toContainText('网关已锁定，请在管理页面解锁');
});

test('异常诊断显示失败率、模型变慢、项目流量和后台健康', async ({ page }) => {
  const now = Date.now();
  const hour = 3600000;
  const buckets = Array.from({ length: 24 }, (_, i) => ({
    started: now - (24 - i) * hour,
    requests: i % 7 === 3 ? 0 : 20 + i,
    failed: i === 20 ? 8 : i === 12 ? 2 : 0,
  }));
  const signals = {
    from: now - 24 * hour, to: now,
    failure: { requests: 500, failed: 10, rate: 2, prev_requests: 400, prev_failed: 2, prev_rate: 0.5, bucket_ms: hour, buckets },
    models: [
      { model_id: 'm1', alias: 'MiniMax-M3', samples: 12, ttft_p50: 6200, base_samples: 90, base_ttft_p50: 2400, ratio: 2.58, slow: true },
      { model_id: 'm2', alias: 'deepseek-flash', samples: 40, ttft_p50: 820, base_samples: 900, base_ttft_p50: 800, ratio: 1.03, slow: false },
      { model_id: 'm3', alias: 'glm-5.3-flash', samples: 2, ttft_p50: 1500, base_samples: 4, base_ttft_p50: 1200, ratio: 1.25, slow: false },
    ],
    projects: [
      { project_id: 'p1', name: 'OpenClaw', kind: 'surge', last_hour: 240, peak_hour: 60, active_days: 7, last_seen: now },
      { project_id: 'p2', name: 'Dustoff', kind: 'silent', last_hour: 0, peak_hour: 18, active_days: 5, last_seen: now - 30 * hour },
    ],
    fallback: { total: 251, served: 250 },
    usage_missing: 3,
    background: {
      last_cleanup: { id: 1, started: now - hour, kind: 'cleanup', detail: { status: 'error', error: 'disk I/O error' } },
      last_cleanup_ok: now - 72 * hour, cleanup_overdue: true, db_bytes: 52428800, db_growth_7d: 3145728,
      disk_free_bytes: 524288000, disk_total_bytes: 21474836480, disk_low: true, metrics_errors: 0, dropped_records: 2, started_at: now - hour,
    },
  };
  const requested: string[] = [];
  await page.route('**/api/**', route => {
    const url = new URL(route.request().url());
    requested.push(url.pathname + url.search);
    const json = url.pathname === '/api/status' ? { configured: true, authenticated: true, locked: false } :
      url.pathname === '/api/admin/state' ? { connections: [], models: [], projects: [], request_count: 0, dropped_records: 0, base_url: 'http://127.0.0.1:8317/v1' } :
      url.pathname === '/api/admin/request-tasks' ? { tasks: [] } :
      url.pathname === '/api/admin/diagnostics/signals' ? signals :
      url.pathname === '/api/admin/diagnostics' ? { groups: [] } : {};
    return route.fulfill({ json });
  });
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.goto('/');
  await page.getByRole('button', { name: /^异常诊断/ }).click();

  const board = page.locator('.diag-board');
  await expect(board.locator('.fr-head')).toContainText('2.0%');
  await expect(board.locator('.fr-head')).toContainText('上一周期 0.5%，升高 1.5 个百分点');
  await expect(board.getByRole('row', { name: /MiniMax-M3/ })).toContainText('变慢');
  await expect(board.getByRole('row', { name: /deepseek-flash/ })).toContainText('正常');
  await expect(board.getByRole('row', { name: /glm-5.3-flash/ })).toContainText('样本少');
  await expect(board).toContainText('最近 1 小时 240 次，过去 7 天最忙的一小时 60 次');
  await expect(board).toContainText('已 24 小时没有调用');
  await expect(board).toContainText('超过 2 天没有成功');
  await expect(board).toContainText('空间不足');
  await expect(board).toContainText('丢失 2');
  await expect(board).toContainText('disk I/O error');
  await expect(board).toContainText('251 次 · 救回 250');

  await board.locator('.fr-bars span').nth(20).hover();
  await expect(board.locator('.fr-read')).toContainText('失败 8');
  if (process.env.SIGNALS_SHOT) await page.screenshot({ path: process.env.SIGNALS_SHOT, fullPage: true });

  await page.getByRole('button', { name: '7D', exact: true }).click();
  await expect(board).toContainText('按来源分类 · 近 7 天');
  await expect(board).toContainText('近 7 天没有异常');
  await expect.poll(() => requested.some(path => path === '/api/admin/diagnostics/signals?window=7d')).toBe(true);

  await page.setViewportSize({ width: 390, height: 844 });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  if (process.env.SIGNALS_SHOT) await page.screenshot({ path: process.env.SIGNALS_SHOT.replace('.png', '-phone.png'), fullPage: true });
});
