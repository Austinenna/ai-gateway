const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const string = value => typeof value === 'string' ? value : '';

// Read only what the upstream actually returned. Never infer reasoning from
// answer text or treat model tool calls as locally executable instructions.
export function responseDetails(output) {
  const parts = [], finishReasons = [], warnings = [];
  const tools = new Map(), blocks = new Map();
  let frames = [], streaming = false;
  try {
    const value = JSON.parse(output);
    if (object(value)) frames = [value];
  } catch {
    streaming = true;
    let invalid = 0;
    for (const frame of output.replaceAll('\r\n', '\n').split('\n\n')) {
      const data = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
      if (!data || data.trim() === '[DONE]') continue;
      try { const value = JSON.parse(data); if (object(value)) frames.push(value); }
      catch { invalid++; }
    }
    if (invalid) warnings.push(`${invalid} 个数据片段无法解析，可能不完整；可在原始数据中查看。`);
  }
  const part = (kind, choice = 0) => {
    const value = { kind, choice, text: '', name: '', id: '', arguments: '' };
    parts.push(value);
    return value;
  };
  const append = (kind, value, choice = 0) => {
    if (typeof value !== 'string' || value === '') return;
    const last = parts.at(-1);
    const target = last?.kind === kind && last.choice === choice ? last : part(kind, choice);
    target.text += value;
  };
  const finish = value => {
    if (typeof value === 'string' && value && !finishReasons.includes(value)) finishReasons.push(value);
  };
  const addBlock = (block, index, choice = 0) => {
    if (!object(block)) return;
    let target;
    if (block.type === 'text' || block.type === 'thinking') {
      target = part(block.type === 'text' ? 'text' : 'thinking', choice);
      target.text = string(block.type === 'text' ? block.text : block.thinking);
    } else if (block.type === 'tool_use') {
      target = part('tool', choice);
      target.name = string(block.name);
      target.id = string(block.id);
      if (block.input !== undefined) target.arguments = JSON.stringify(block.input);
    } else {
      target = part('other', choice);
      target.name = string(block.type) || '未知内容块';
      target.text = block.type === 'redacted_thinking' ? '上游返回了不可读的思考块，没有提供可展示的思考文本。' : JSON.stringify(block, null, 2);
    }
    blocks.set(index, { target, hasArgumentDelta: false });
  };
  for (const frame of frames) {
    if (Array.isArray(frame.choices)) for (const [position, choice] of frame.choices.entries()) {
      if (!object(choice)) continue;
      const index = Number.isInteger(choice.index) ? choice.index : position;
      const delta = object(choice.delta) ? choice.delta : object(choice.message) ? choice.message : {};
      append('thinking', delta.reasoning_content || delta.reasoning, index);
      if (Array.isArray(delta.content)) delta.content.forEach((block, i) => addBlock(block, `chat-${index}-${i}`, index));
      else append('text', delta.content, index);
      const calls = Array.isArray(delta.tool_calls) ? delta.tool_calls : object(delta.function_call) ? [{ function: delta.function_call, index: 0 }] : [];
      calls.forEach((call, i) => {
        if (!object(call)) return;
        const key = `${index}:${Number.isInteger(call.index) ? call.index : i}`;
        let target = tools.get(key);
        if (!target) { target = part('tool', index); tools.set(key, target); }
        if (typeof call.id === 'string' && call.id) target.id = call.id;
        if (object(call.function)) {
          target.name += string(call.function.name);
          if (typeof call.function.arguments === 'string') target.arguments += call.function.arguments;
          else if (call.function.arguments !== undefined) target.arguments = JSON.stringify(call.function.arguments);
        }
      });
      finish(choice.finish_reason);
    }
    if (Array.isArray(frame.content)) frame.content.forEach((block, i) => addBlock(block, i));
    if (frame.type === 'content_block_start') addBlock(frame.content_block, frame.index);
    if (frame.type === 'content_block_delta' && object(frame.delta)) {
      const delta = frame.delta;
      let entry = blocks.get(frame.index);
      if (!entry && ['text_delta', 'thinking_delta', 'input_json_delta'].includes(delta.type)) {
        const kind = delta.type === 'text_delta' ? 'text' : delta.type === 'thinking_delta' ? 'thinking' : 'tool';
        entry = { target: part(kind), hasArgumentDelta: false };
        blocks.set(frame.index, entry);
      }
      if (entry) {
        if (delta.type === 'text_delta') entry.target.text += string(delta.text);
        if (delta.type === 'thinking_delta') entry.target.text += string(delta.thinking);
        if (delta.type === 'input_json_delta') {
          // Messages sends input:{} in the start event before argument deltas.
          if (!entry.hasArgumentDelta) entry.target.arguments = '';
          entry.hasArgumentDelta = true;
          entry.target.arguments += string(delta.partial_json);
        }
      }
    }
    finish(frame.stop_reason);
    if (object(frame.delta)) finish(frame.delta.stop_reason);
    if (object(frame.error)) append('error', typeof frame.error.message === 'string' ? frame.error.message : JSON.stringify(frame.error, null, 2));
  }
  const visible = parts.filter(p => p.kind === 'tool' || p.text);
  return { parts: visible, finishReasons, warnings, streaming, hasData: frames.length > 0,
    toolCount: visible.filter(p => p.kind === 'tool').length,
    thinkingCount: visible.filter(p => p.kind === 'thinking').length };
}

export function responsePlaceholder(details) {
  const returned = [];
  if (details.thinkingCount) returned.push('思考文本');
  if (details.toolCount) returned.push(`${details.toolCount} 个工具调用`);
  if (returned.length) return `本次未返回回答正文，已返回${returned.join('和')}。请查看“响应详情”。`;
  if (details.hasData) return '本次已收到上游数据，但没有可展示的回答正文。请查看“响应详情”或原始数据。';
  return '这条记录没有可解析的回答正文，请查看原始数据。';
}
