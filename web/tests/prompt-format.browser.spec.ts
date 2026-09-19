import { test, expect } from '@playwright/test';

const prompt = [
  "<system-reminder data-role=\"user-context\">",
  "<user_info>",
  "OS Version: darwin",
  "Shell: /bin/zsh",
  "IDE Theme: light",
  "Workspace Folder: /demo/WorkBuddy/sample",
  "Note: Prefer absolute paths.",
  "</user_info>",
  "<identity_context>",
  "The following files are included in this turn.",
  "",
  "## SOUL.md",
  "Path: /demo/SOUL.md",
  "---",
  "title: \"SOUL.md Template\"",
  "summary: \"Workspace preferences\"",
  "read_when:",
  "- Startup",
  "---",
  "# Working style",
  "",
  "- Keep **answers short**.",
  "- Show `code` when useful.",
  "",
  "</identity_context>",
  "</system-reminder>",
  "",
  "## 我的请求",
  "",
  "请检查 **登录流程**，并解释以下代码：",
  "",
  "```js",
  "const token = \"demo\";",
  "console.log(token);",
  "```",
  ""
].join('\n');

test.beforeEach(async ({ page }) => {
  const base = { id: 'formatted', project_id: 'p', project_name: '格式化演示', model_id: 'm', alias: 'demo', protocol: 'chat', started: 1800000000000, duration_ms: 1200, status: 200, state: 'complete', input_tokens: 10, output_tokens: 4, output: '{"choices":[{"message":{"content":"ok"}}]}', input: JSON.stringify({ messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }] }) };
  const unsafe = '<script>window.promptExecuted = true</script>\n\n![tracking](https://untrusted.test/pixel)\n\n[bad](javascript:alert(1))\n\n[local](/api/admin/logout)\n\n<unknown-tag>literal</unknown-tag>\n\n## 可显示正文';
  const records = [base, { ...base, id: 'unsafe', project_name: '文本边界', input: JSON.stringify({ messages: [{ role: 'user', content: unsafe }] }) }];
  await page.route('**/api/**', route => {
    const path = new URL(route.request().url()).pathname;
    const json = path === '/api/status' ? { configured: true, authenticated: true, locked: false } : path === '/api/admin/state' ? { connections: [], models: [], projects: [], request_count: 2, dropped_records: 0, base_url: '' } : path === '/api/admin/requests' ? records : records.find(r => path === '/api/admin/requests/' + r.id) || {};
    return route.fulfill({ json });
  });
  await page.goto('/');
  await page.locator('nav').getByRole('button', { name: /^请求记录/ }).click();
  await page.locator('.request-item').filter({ hasText: '格式化演示' }).click();
});

test('USER 上下文折叠、环境字段、Markdown 和 YAML 排版，原文完整保留', async ({ page }, info) => {
  const user = page.locator('.message').first();
  const context = user.locator('.prompt-section').first();
  await expect(context).not.toHaveAttribute('open', '');
  await expect(user.getByRole('heading', { name: '我的请求' })).toBeVisible();
  await expect(user.locator('.prompt-markdown strong').filter({ hasText: '登录流程' })).toBeVisible();
  await context.locator(':scope > summary').click();
  await expect(user.locator('.prompt-environment')).toContainText('操作系统darwin');
  await expect(user.locator('.prompt-environment')).toContainText('工作目录/demo/WorkBuddy/sample');
  await user.locator('summary').filter({ hasText: '身份与偏好' }).click();
  await expect(user.getByRole('heading', { name: 'SOUL.md', exact: true })).toBeVisible();
  await expect(user.locator('code.language-yaml')).toContainText('summary: "Workspace preferences"');
  await expect(user.locator('.prompt-markdown li').filter({ hasText: 'Keep answers short.' })).toBeVisible();
  await expect(user.locator('code.language-js')).toContainText('const token = "demo";');
  await page.screenshot({ path: info.outputPath('prompt-format-desktop.png'), fullPage: true, animations: 'disabled' });
  await user.getByRole('button', { name: '原文', exact: true }).click();
  expect(await user.locator('.prompt-source').textContent()).toBe(prompt);
  await user.getByRole('button', { name: '格式化', exact: true }).click();
  await context.locator(':scope > summary').click();
  for (const width of [1024, 390]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath(`prompt-format-${width}.png`), fullPage: true, animations: 'disabled' });
  }
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.screenshot({ path: info.outputPath('prompt-format-dark.png'), fullPage: true, animations: 'disabled' });
  await page.getByRole('button', { name: '原始数据', exact: true }).click();
  await expect(page.locator('.detail-content pre').first()).toContainText('system-reminder');
});

test('显示外来文本不执行 HTML，不加载远程图片或生成管理接口链接', async ({ page }) => {
  let remote = false;
  page.on('request', r => { if (r.url().includes('untrusted.test')) remote = true; });
  await page.locator('.request-item').filter({ hasText: '文本边界' }).click();
  const user = page.locator('.message').first();
  await expect(user.getByRole('heading', { name: '可显示正文' })).toBeVisible();
  await expect(user).toContainText('<script>window.promptExecuted = true</script>');
  await expect(user).toContainText('<unknown-tag>literal</unknown-tag>');
  await expect(user.locator('script, img, a')).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as {promptExecuted?: boolean}).promptExecuted)).toBeUndefined();
  expect(remote).toBe(false);
});
