import { test, expect } from '@playwright/test';

const now = Date.now(), from = now - 24 * 60 * 60 * 1000;
const distribution = (p50: number | null, p95: number | null, count = 6) => ({ p50, p95, count });
const summary = {
  requests: 10, completed: 6, failed: 1, canceled: 1, active: 2, success_rate: 600 / 7, rpm: 0.0069,
  errors: { rate_limit: 1 }, input_tokens: 60000, output_tokens: 3306, cache_read_tokens: 48000, cache_write_tokens: 0,
  input_samples: 6, output_samples: 6, cache_samples: 6, cache_write_samples: 0,
  usage_complete: 6, usage_eligible: 8, cache_ratio: 80,
  ttft: distribution(1000, 2000), ttfc: distribution(3500, 5100), duration: distribution(12500, 18000), speed: distribution(50, 60),
};
const record = {
  id: 'monitor-complete', project_id: 'p1', project_name: '研发助手', model_id: 'm1', alias: 'coding',
  connection_id: 'c1', connection_name: '研发模型连接', upstream_model: 'test-model', provider: 'zhipu', protocol: 'chat',
  started: now - 60000, duration_ms: 12500, first_token_ms: 1000, first_text_ms: 3500, last_token_ms: 12000,
  timing_version: 1, metrics_version: 1, stream: true, forwarded: true, forward_offset_ms: 5,
  status: 200, upstream_status: 200, state: 'complete', input_tokens: 10000, output_tokens: 551,
  input_total_tokens: 10000, input_uncached_tokens: 2000, cache_read_tokens: 8000, cache_write_tokens: null,
  output_reported: true, usage_status: 'complete', output_tps: 50, tpot_ms: 20, truncated: false,
  input: JSON.stringify({ messages: [
    { role: 'system', content: '你是团队的研发助手。回答时先说明结论，再补充必要的依据。\n使用简洁的中文，保留准确的指标名称。' },
    { role: 'user', content: [{ type: 'text', text: '请介绍 TTFT 和 TTFC 的区别。\n另外，缓存命中的 Token 是否包含在输入总量里？' }] },
  ] }),
  output: JSON.stringify({ choices: [{ message: { content: 'TTFT 记录首段有效内容到达的时间，包含思考、正文和工具调用；TTFC 只记录正文开始出现的时间。\n\nChat 协议中，缓存读取已经包含在输入 Token 总量中，不需要再相加。' } }] }),
};
const missing = { ...record, id: 'monitor-missing', project_name: '用量未报告', input_total_tokens: null, input_uncached_tokens: null, cache_read_tokens: null, output_reported: false, output_tokens: 0, usage_status: 'unknown', output_tps: null, tpot_ms: null };
const zero = { ...record, id: 'monitor-zero', project_name: '明确零用量', stream: false, first_token_ms: null, first_text_ms: null, input_total_tokens: 0, input_uncached_tokens: 0, cache_read_tokens: 0, input_tokens: 0, output_tokens: 0, output_tps: null, tpot_ms: null };
const errored = { ...record, id: 'monitor-error', project_name: '流内错误', state: 'error', error_type: 'rate_limit', usage_status: 'partial', output_tps: null, tpot_ms: null };
const minimax = { ...record, id: 'monitor-minimax', project_name: '自动缓存未单列写入', provider: 'minimax', upstream_model: 'MiniMax-M3', protocol: 'messages', alias: 'MiniMax-M3', input_tokens: 18838, input_total_tokens: 18838, input_uncached_tokens: 117, cache_read_tokens: 18721, cache_write_tokens: null, input_total_basis: 'minimax_auto_cache', output_tokens: 185, usage_status: 'partial', output_tps: null, tpot_ms: null };
const minimaxZero = { ...minimax, id: 'monitor-minimax-zero', project_name: '自动缓存明确零写入', cache_write_tokens: 0, usage_status: 'complete' };

test.beforeEach(async ({ page }) => {
  const records = [record, missing, zero, errored, minimax, minimaxZero];
  await page.route('**/api/**', route => {
    const url = new URL(route.request().url()), path = url.pathname;
    const all = url.searchParams.get('window') === 'all', since = now - 14 * 24 * 3600000;
    const rangeFrom = all ? since : from;
    const rangeSummary = all ? { ...summary, requests: 30, completed: 26, success_rate: 2600 / 27, input_tokens: 260000, output_tokens: 14326 } : summary;
    const metrics = {
      from: rangeFrom, to: now, monitoring_since: since, summary: rangeSummary,
      models: [
        { ...rangeSummary, model_id: 'm1', alias: 'coding', connection_id: 'c1', connection_name: '研发模型连接' },
        { ...summary, requests: 4, model_id: '', alias: '', connection_id: '', connection_name: '' },
        { ...summary, requests: 2, model_id: 'm2', alias: 'light', connection_id: 'c1', connection_name: '研发模型连接' },
      ],
      buckets: Array.from({ length: 24 }, (_, i) => {
        const requests = all && i === 0 ? 20 : i >= 19 ? [2, 1, 2, 2, 3][i - 19] : 0;
        return { started: rangeFrom + i * (now - rangeFrom) / 24, requests, failed: i === 23 ? 1 : 0, canceled: i === 22 ? 1 : 0, rpm: requests * 60000 / ((now - rangeFrom) / 24) };
      }),
      recent: records, options: { projects: [{ id: 'p1', name: '研发助手' }], connections: [{ id: 'c1', name: '研发模型连接' }], models: [{ id: 'm1', name: 'coding' }] }, metrics_errors: 0, dropped_records: 0,
    };
    const json = path === '/api/status' ? { configured: true, authenticated: true, locked: false } :
      path === '/api/admin/state' ? { connections: [{ id: 'c1', name: '研发模型连接', provider: 'zhipu', protocol: 'chat', enabled: true }], models: [{ id: 'm1', alias: 'coding', connection_id: 'c1', enabled: true }], projects: [{ id: 'p1', name: '研发助手', enabled: true, model_ids: ['m1'] }], request_count: 4, dropped_records: 0, base_url: 'http://127.0.0.1:18318/v1' } :
      path === '/api/admin/metrics' ? metrics : path === '/api/admin/requests' ? records : records.find(r => path === '/api/admin/requests/' + r.id);
    return route.fulfill({ json: json ?? {} });
  });
  await page.goto('/');
});

test('全部范围显示累计统计并保留筛选与刷新', async ({ page }, info) => {
  await expect(page.getByRole('button', { name: '近 24 小时', exact: true })).toHaveAttribute('aria-pressed', 'true');
  const allButton = page.getByRole('button', { name: '全部', exact: true });
  await allButton.click();
  await expect(allButton).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.monitor-cards')).toContainText('260,000');
  await expect(page.locator('.monitor-trend')).toContainText('30 次');
  await expect(page.locator('.trend-column')).toHaveCount(24);
  await expect(page.locator('.monitor-models')).toContainText('260,000');
  await page.getByText('统计口径与采集范围', { exact: true }).click();
  await expect(page.locator('.monitor-definitions')).toContainText('旧记录保留在请求记录中，不补入新统计');
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 960 });
    await page.locator('.workspace').evaluate(el => { el.scrollTop = 0; });
    await page.evaluate(() => window.scrollTo(0, 0));
    await expect(allButton).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath(`overview-all-${width}.png`), fullPage: width === 390 });
  }
  await page.setViewportSize({ width: 1440, height: 960 });
  const waitQuery = (expected: Record<string, string>) => page.waitForResponse(r => {
    const url = new URL(r.url());
    return url.pathname === '/api/admin/metrics' && Object.entries({ window: 'all', ...expected }).every(([key, value]) => url.searchParams.get(key) === value);
  });
  let response = waitQuery({ project_id: 'p1' });
  await page.getByLabel('监控项目', { exact: true }).selectOption('p1'); await response;
  response = waitQuery({ project_id: 'p1', stream: 'true' });
  await page.getByLabel('监控调用方式').selectOption('true'); await response;
  response = waitQuery({ project_id: 'p1', stream: 'true', model_id: 'm1', connection_id: 'c1' });
  await page.locator('.monitor-models').getByRole('button', { name: 'coding', exact: true }).click(); await response;
  response = waitQuery({ project_id: 'p1', stream: 'true', model_id: 'm1', connection_id: 'c1' });
  await page.getByRole('button', { name: '刷新监控', exact: true }).click(); await response;
  response = waitQuery({ project_id: '', stream: '', model_id: '', connection_id: '' });
  await page.getByRole('button', { name: '清除筛选', exact: true }).click(); await response;
  await expect(allButton).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: '近 1 小时', exact: true }).click();
  await expect(page.locator('.monitor-cards')).toContainText('60,000');
  await expect(page.locator('.monitor-trend')).toContainText('10 次');
});

test('六组监控支持筛选、跳转详情与桌面手机布局', async ({ page }, info) => {
  await expect(page.locator('.monitor-models tbody tr td:first-child')).toHaveText(['coding研发模型连接', 'light研发模型连接', '未路由请求网关前置检查']);
  await expect(page.locator('.monitor-cards .metric-card')).toHaveCount(6);
  await expect(page.locator('.metric-health')).toContainText('85.7%');
  await expect(page.locator('.monitor-cards')).toContainText('60,000');
  await expect(page.locator('.monitor-cards')).toContainText('80%');
  await expect(page.locator('.monitor-errors')).toContainText('上游限流 · 429');
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: 960 });
    await page.screenshot({ path: info.outputPath(`overview-${width}.png`), fullPage: width === 390 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  await page.setViewportSize({ width: 1440, height: 960 });
  const waitQuery = (key: string, value: string) => page.waitForResponse(r => r.url().includes('/api/admin/metrics?') && new URL(r.url()).searchParams.get(key) === value);
  let response = waitQuery('window', '7d');
  await page.getByRole('button', { name: '近 7 天', exact: true }).click(); await response;
  response = waitQuery('project_id', 'p1'); await page.getByLabel('监控项目', { exact: true }).selectOption('p1'); await response;
  response = waitQuery('stream', 'true'); await page.getByLabel('监控调用方式').selectOption('true'); await response;
  response = waitQuery('model_id', 'm1'); await page.locator('.monitor-models').getByRole('button', { name: 'coding', exact: true }).click(); await response;
  await expect(page.getByLabel('监控连接', { exact: true })).toHaveValue('c1');
  await page.getByRole('button', { name: '查看请求 monitor-complete', exact: true }).click();
  await expect(page.locator('.detail-head')).toContainText('首个 Token · TTFT1 s');
  await expect(page.locator('.detail-head')).toContainText('正文首字 · TTFC3.5 s');
  for (const width of [1920, 1440, 1280, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.screenshot({ path: info.outputPath(`request-messages-${width}.png`), fullPage: width === 390, animations: 'disabled' });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.screenshot({ path: info.outputPath('request-messages-dark.png'), animations: 'disabled' });
  await page.emulateMedia({ colorScheme: 'light' });
  await page.getByRole('button', { name: '性能与用量', exact: true }).click();
  await expect(page.locator('.detail-usage')).toContainText('10,000');
  await expect(page.locator('.cache-ratio')).toContainText('80%');
  await expect(page.locator('.detail-speed')).toContainText('20 ms/Token');
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 960 });
    await page.screenshot({ path: info.outputPath(`request-metrics-${width}.png`), fullPage: width === 390, animations: 'disabled' });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
});

test('用量未知与零、非流式、HTTP 200 流内错误有明确区别', async ({ page }) => {
  await page.getByRole('button', { name: '查看请求 monitor-missing', exact: true }).click();
  await page.getByRole('button', { name: '性能与用量', exact: true }).click();
  await expect(page.locator('.usage-state')).toHaveText('厂商未报告用量');
  await expect(page.locator('.detail-usage dd').first()).toHaveText('—');
  await page.locator('.request-item').filter({ hasText: '明确零用量' }).click();
  await expect(page.locator('.detail-head')).toContainText('TTFT非流式');
  await page.getByRole('button', { name: '性能与用量', exact: true }).click();
  await expect(page.locator('.detail-usage dd').first()).toHaveText('0');
  await page.locator('.request-item').filter({ hasText: '流内错误' }).click();
  await expect(page.locator('.detail-head .result-label')).toHaveText('失败');
  await expect(page.locator('.request-outcome-note')).toContainText('上游限流 · 429 · HTTP 200');
});

test('MiniMax 自动缓存显示总输入、命中率并区分未单列与零', async ({ page }, info) => {
  await page.getByRole('button', { name: '查看请求 monitor-minimax', exact: true }).click();
  await expect(page.locator('.detail-head')).toContainText('18,838 / 185');
  await page.getByRole('button', { name: '性能与用量', exact: true }).click();
  const usage = page.locator('.detail-usage');
  await expect(usage.locator('dd')).toHaveText(['18,838', '117', '18,721', '未单列（自动缓存）', '185', '19,023']);
  await expect(page.locator('.cache-ratio')).toContainText('99.4%');
  await expect(usage).toContainText('输入总量＝普通输入＋缓存读取');
  await expect(page.locator('.usage-state')).toHaveText('输入与输出已报告 · 最终用量未确认');
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath(`minimax-usage-${width}.png`), fullPage: width === 390 });
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.locator('.request-item').filter({ hasText: '自动缓存明确零写入' }).click();
  await page.getByRole('button', { name: '性能与用量', exact: true }).click();
  await expect(usage.locator('dd').nth(3)).toHaveText('0');
  await expect(page.locator('.usage-state')).toHaveText('输入与最终输出已报告');
});
