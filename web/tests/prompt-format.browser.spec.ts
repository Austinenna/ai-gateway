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
].join('\r\n');

test.beforeEach(async ({ page }) => {
  const base = { id: 'formatted', project_id: 'p', project_name: '格式化演示', model_id: 'm', alias: 'demo', protocol: 'chat', started: 1800000000000, duration_ms: 1200, status: 200, state: 'complete', input_tokens: 10, output_tokens: 4, output: '{"choices":[{"message":{"content":"ok"}}]}', input: JSON.stringify({ messages: [{ role: 'system', content: prompt }, { role: 'user', content: [{ type: 'text', text: prompt }] }] }) };
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

test('USER 与 SYSTEM 只做同样的 Markdown 排版，保留原始标签属性和文字', async ({ page }, info) => {
  const system = page.locator('.message').nth(0), user = page.locator('.message').nth(1);
  await user.getByRole('button', { name: '展开全文', exact: true }).click();
  await expect(user.getByRole('heading', { name: '我的请求' })).toBeVisible();
  await expect(user.locator('.prompt-markdown strong').filter({ hasText: '登录流程' })).toBeVisible();
  const markdown = user.locator('.prompt-markdown');
  await expect(markdown).toHaveCSS('white-space', 'pre-wrap');
  for (const original of ['<system-reminder data-role="user-context">', '<user_info>', 'OS Version: darwin', 'IDE Theme: light', 'Workspace Folder: /demo/WorkBuddy/sample', '</user_info>', '<identity_context>', '</identity_context>', '</system-reminder>']) {
    await expect(markdown).toContainText(original);
  }
  await expect(user.locator('.prompt-section, .prompt-environment, details, dl')).toHaveCount(0);
  const visibleText = await markdown.textContent();
  for (const added of ['已识别上下文区块', '上下文提示', '运行环境', '身份与偏好', '操作系统', '界面主题', '工作目录']) expect(visibleText).not.toContain(added);
  await expect(system.locator('.prompt-markdown')).toHaveText(await markdown.textContent() || '');
  expect(visibleText!.indexOf('<user_info>')).toBeLessThan(visibleText!.indexOf('<identity_context>'));
  expect(visibleText!.indexOf('</system-reminder>')).toBeLessThan(visibleText!.indexOf('我的请求'));
  await expect(user.locator('code.language-yaml')).toHaveCount(0);
  await expect(user.locator('code.language-js')).toContainText('const token = "demo";');
  await user.scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('literal-markdown-desktop.png'), animations: 'disabled' });
  await user.getByRole('button', { name: '原文', exact: true }).click();
  expect(await user.locator('.prompt-source').textContent()).toBe(prompt);
  await user.getByRole('button', { name: '格式化', exact: true }).click();
  for (const width of [1024, 390]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath(`literal-markdown-${width}.png`), fullPage: true, animations: 'disabled' });
  }
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.screenshot({ path: info.outputPath('literal-markdown-dark.png'), fullPage: true, animations: 'disabled' });
  await page.getByRole('button', { name: '原始数据', exact: true }).click();
  const displayedJSON = JSON.parse(await page.locator('.detail-content pre').first().textContent() || '{}');
  expect(displayedJSON.messages[1].content[0].text).toBe(prompt);
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
  await expect(user).toContainText('![tracking](https://untrusted.test/pixel)');
  await expect(user).toContainText('[bad](javascript:alert(1))');
  await expect(user).toContainText('[local](/api/admin/logout)');
  expect(await page.evaluate(() => (window as unknown as {promptExecuted?: boolean}).promptExecuted)).toBeUndefined();
  expect(remote).toBe(false);
});
