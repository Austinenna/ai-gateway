import { test, expect } from '@playwright/test';

const stateWith = (models: { id: string; alias: string; protocols: string[] }[]) => ({
  connections: [{
    id: 'c1', name: 'conn', provider: 'custom', enabled: true,
    endpoints: { chat: 'https://a.test', messages: 'https://a.test', 'dashscope-asr': 'https://a.test', 'deepseek-search': 'https://a.test' },
  }],
  models: models.map((m) => ({ ...m, connection_id: 'c1', enabled: true })),
  projects: [{ id: 'p1', name: 'kairos', enabled: true, model_ids: ['asr'] }],
  request_count: 0, dropped_records: 0, base_url: 'http://127.0.0.1:8317/v1',
});

async function openMatrix(page, state) {
  await page.route('**/api/**', (route) => {
    const path = new URL(route.request().url()).pathname;
    const json = path === '/api/status' ? { configured: true, authenticated: true, locked: false } :
      path === '/api/admin/state' ? state :
      path === '/api/admin/request-tasks' ? { tasks: [] } : {};
    return route.fulfill({ json });
  });
  await page.goto('/');
  await page.getByRole('button', { name: /^项目与权限/ }).click();
  await expect(page.locator('.gm')).toBeVisible();
}

test('授权矩阵把语言模型排在前面，并用竖线与语音和工具分开', async ({ page }) => {
  await openMatrix(page, stateWith([
    { id: 'chat', alias: 'chat-model', protocols: ['chat'] },
    { id: 'asr', alias: 'asr-model', protocols: ['dashscope-asr'] },
    { id: 'msg', alias: 'messages-model', protocols: ['messages'] },
    { id: 'search', alias: 'search-tool', protocols: ['deepseek-search'] },
  ]));
  const headers = page.locator('.gm thead th.m, .gm thead th.sep');
  await expect(headers).toHaveCount(5);
  expect(await headers.evaluateAll((cells) => cells.map((c) => (c.classList.contains('sep') ? '|' : c.getAttribute('title')?.split(' · ')[0])))).toEqual([
    'chat-model', 'messages-model', '|', 'asr-model', 'search-tool',
  ]);
  await expect(page.locator('.gm tbody tr').first().locator('td.sep')).toHaveCount(1);
  if (process.env.MATRIX_SHOT) await page.locator('.gm-wrap').screenshot({ path: process.env.MATRIX_SHOT });
  // Reordering must keep each checkbox on its own model.
  await expect(page.getByRole('button', { name: '取消授权 kairos 使用 asr-model' })).toHaveAttribute('aria-pressed', 'true');
  const row = page.locator('.gm tbody tr').first();
  expect(await row.locator('td.c, td.sep').evaluateAll((cells) => cells.map((c) => (c.classList.contains('sep') ? '|' : c.querySelector('button')?.getAttribute('aria-pressed'))))).toEqual([
    'false', 'false', '|', 'true', 'false',
  ]);
});

test('只有一类模型时不画分割线', async ({ page }) => {
  await openMatrix(page, stateWith([{ id: 'chat', alias: 'chat-model', protocols: ['chat'] }]));
  await expect(page.locator('.gm th.sep')).toHaveCount(0);
});

test('只有语音和工具时也不画分割线', async ({ page }) => {
  await openMatrix(page, stateWith([{ id: 'asr', alias: 'asr-model', protocols: ['dashscope-asr'] }]));
  await expect(page.locator('.gm th.sep')).toHaveCount(0);
});
