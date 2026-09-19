// Interpret only known, balanced, line-delimited prompt wrappers. This is not an XML/HTML evaluator.
const labels = {
  'system-reminder': '上下文提示', user_info: '运行环境', identity_context: '身份与偏好',
  environment_context: '环境上下文', environment_details: '环境信息',
  project_context: '项目上下文', user_query: '用户提问', user_request: '用户请求',
};
export function promptSections(text, depth = 0) {
  if (depth >= 8) return [{ type: 'text', raw: text }];
  const sections = [], stack = [];
  let offset = 0, copied = 0, fence = null;
  for (const line of text.match(/[^\n]*(?:\n|$)/g) || []) {
    if (!line) continue;
    const start = offset; offset += line.length;
    const fenceMatch = line.match(/^ {0,3}(`{3,}|~{3,})([^\r\n]*)/);
    if (fence) {
      if (fenceMatch && fenceMatch[1][0] === fence.char && fenceMatch[1].length >= fence.length && !fenceMatch[2].trim()) fence = null;
      continue;
    }
    if (fenceMatch) { fence = { char: fenceMatch[1][0], length: fenceMatch[1].length }; continue; }
    const tag = line.match(/^ {0,3}<(\/?)([\w-]+)([^<>]*)>\s*$/);
    if (!tag || !Object.hasOwn(labels, tag[2])) continue;
    if (!tag[1] && !tag[3].endsWith('/')) {
      stack.push({ start, bodyStart: offset, tag: tag[2], attributes: tag[3].trim() });
    } else if (tag[1] && !tag[3].trim()) {
      if (!stack.length || stack.at(-1).tag !== tag[2]) { stack.length = 0; continue; }
      const open = stack.pop();
      if (stack.length) continue;
      if (open.start > copied) sections.push({ type: 'text', raw: text.slice(copied, open.start) });
      sections.push({ type: 'section', tag: open.tag, label: labels[open.tag], attributes: open.attributes,
        raw: text.slice(open.start, offset), body: text.slice(open.bodyStart, start),
        children: promptSections(text.slice(open.bodyStart, start), depth + 1),
        collapsed: !['user_info', 'environment_context', 'environment_details', 'user_query', 'user_request'].includes(open.tag) });
      copied = offset;
    }
  }
  if (copied < text.length || !sections.length) sections.push({ type: 'text', raw: text.slice(copied) });
  return sections;
}

// Recognize YAML-style front matter conservatively, including file metadata after "Path:".
// Never reinterpret the contents of code fences or ordinary horizontal rules.
export function frontMatterAsCode(text) {
  const lines = text.replaceAll('\r\n', '\n').split('\n');
  let fence = null;
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (fence) {
      if (match && match[1][0] === fence.char && match[1].length >= fence.length && !match[2].trim()) fence = null;
      continue;
    }
    if (match) { fence = { char: match[1][0], length: match[1].length }; continue; }
    if (lines[i].trim() !== '---' || !lines[i + 1]?.match(/^[\w-]+:\s/)) continue;
    let end = i + 1;
    while (end < lines.length && lines[end].trim() !== '---' && end - i < 80) end++;
    if (end === lines.length || lines[end].trim() !== '---') continue;
    const body = lines.slice(i + 1, end).join('\n');
    if (/^\s*(?:#{1,6}\s|`{3,}|~{3,})/m.test(body)) continue;
    const longest = Math.max(2, ...(body.match(/`+/g) || []).map(v => v.length));
    const marker = '`'.repeat(longest + 1);
    // Keep delimiters visible inside the code block; this is a reading aid, not a YAML parser.
    lines.splice(i, end - i + 1, '', marker + 'yaml', '---', ...lines.slice(i + 1, end), '---', marker, '');
    i += end - i + 4;
  }
  return lines.join('\n');
}
export function environmentFields(text) {
  const lines = text.trim().split(/\r?\n/).filter(line => line.trim());
  const fields = lines.map(line => line.match(/^([\w][\w /.-]{0,50}):\s*(.*)$/));
  return lines.length && fields.every(Boolean) ? fields.map(m => ({ name: m[1], value: m[2] })) : null;
}
export const hasPromptFormatting = text => /(?:^|\n) {0,3}(?:#{1,6}\s|[-*+]\s|\d+[.)]\s|`{3,}|~{3,}|>|<[\w-]+[\s>])|\*\*|`[^`\n]+`|\[[^\]\n]+\]\(/.test(text);
