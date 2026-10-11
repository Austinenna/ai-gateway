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
  await page.getByRole('button', { name: '异常与诊断', exact: true }).click();
  await expect(page.getByRole('heading', { name: '异常与诊断', level: 1 })).toBeVisible();
  await expect(page.locator('.diagnostic-runtime-card.locked')).toContainText('已锁定');
  await expect(page.locator('.diagnostic-group-list')).toContainText('网关已锁定，请在管理页面解锁');
  await expect(page.locator('.diagnostic-detail')).toContainText('没有到达上游');
  await page.getByRole('button', { name: '查看代表请求', exact: false }).click();
  await expect(page.locator('.request-diagnostic-note')).toContainText('网关已锁定，请在管理页面解锁');
});
