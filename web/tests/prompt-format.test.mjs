import test from 'node:test';
import assert from 'node:assert/strict';
import { promptSections, frontMatterAsCode, environmentFields } from '../src/prompt-format.mjs';

test('WorkBuddy wrappers preserve original content and separate context from actual query', () => {
  const raw = '<system-reminder data-role="user-context">\r\n<user_info>\r\nOS Version: darwin\r\nShell: /bin/zsh\r\n</user_info>\r\n<identity_context>\r\n## SOUL.md\r\nKeep original text.\r\n</identity_context>\r\n</system-reminder>\r\n\r\n## 我的请求\r\n- 请整理文件\r\n';
  const nodes = promptSections(raw);
  assert.equal(nodes.map(n => n.raw).join(''), raw);
  assert.equal(nodes[0].type, 'section');
  assert.equal(nodes[0].collapsed, true);
  assert.equal(nodes[0].attributes, 'data-role="user-context"');
  assert.equal(nodes[0].children[0].tag, 'user_info');
  assert.equal(nodes[0].children[0].collapsed, false);
  assert.equal(nodes[0].children[1].label, '身份与偏好');
  assert.match(nodes[1].raw, /我的请求/);
  assert.deepEqual(environmentFields(nodes[0].children[0].body), [{ name: 'OS Version', value: 'darwin' }, { name: 'Shell', value: '/bin/zsh' }]);
});
test('Malformed, unknown, quoted and fenced tags stay readable as text, without lost content', () => {
  for (const raw of ['<system-reminder>\nunfinished', '<user_info>\ntext\n</identity_context>', 'text <user_info>inline</user_info>', '```xml\n<user_info>\nx: y\n</user_info>\n```', '~~~~xml\n<user_info>\nx: y\n</user_info>\n~~~~', '    <user_info>\n    text\n    </user_info>', '<unknown>\ntext\n</unknown>', '<script>alert(1)</script>', '<constructor>\nx\n</constructor>']) {
    const nodes = promptSections(raw);
    assert.equal(nodes.map(n => n.raw).join(''), raw);
    assert.ok(nodes.every(n => n.type === 'text'));
  }
  const repeated = '<user_info>\na: b\n</user_info>\n'.repeat(3);
  assert.equal(promptSections(repeated).length, 3);
  assert.equal(environmentFields('OS Version: darwin\nnot a field'), null);
});
test('YAML metadata is displayed as a code block while ordinary separators and fenced code survive', () => {
  const raw = '## SOUL.md\nPath: /demo/SOUL.md\n---\ntitle: "Example"\nsummary: "Notes"\nread_when:\n- Startup\n---\n# Instructions\n\n---\nNormal paragraph';
  const converted = frontMatterAsCode(raw);
  assert.match(converted, /```yaml\n---\ntitle: "Example"/);
  assert.match(converted, /---\n```\n\n# Instructions/);
  assert.ok(converted.endsWith('---\nNormal paragraph'));
  const fenced = '```text\n---\ntitle: Example\n---\n```';
  assert.equal(frontMatterAsCode(fenced), fenced);
});
