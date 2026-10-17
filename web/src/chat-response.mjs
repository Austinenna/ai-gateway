const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' ? value : '';
const contentText = value => Array.isArray(value)
  ? value.filter(block => block?.type === 'text').map(block => text(block.text)).join('')
  : text(value);

export function chatError(value, fallback = '模型调用失败，请查看请求详情。') {
  return text(value?.error?.message) || text(value?.message) || fallback;
}

// The composer carries visible text only. Thinking and error descriptions never
// become fabricated assistant messages when changing models or protocols.
export function conversationHistory(messages) {
  return messages.filter(message => ['user', 'assistant'].includes(message.role) && message.text?.trim())
    .map(message => ({ role: message.role, content: message.text }));
}

// Parse each SSE event once, preserving boundaries across arbitrary network
// chunks. TextDecoder handles byte boundaries before strings reach this parser.
export function createChatResponse(protocol) {
  const state = { text: '', thinking: '', error: '', ended: false, hasData: false, toolCalls: false, finishReason: '' };
  let buffer = '', data = [], finishedChoice = false;
  function block(value) {
    if (value?.type === 'text') state.text += text(value.text);
    if (value?.type === 'thinking') state.thinking += text(value.thinking);
    if (value?.type === 'tool_use') state.toolCalls = true;
  }
  function accept(value) {
    if (!object(value)) { state.error ||= '上游返回了无法识别的响应。'; return; }
    state.hasData = true;
    if (value.error) state.error = chatError(value);
    if (protocol === 'chat') {
      const choice = Array.isArray(value.choices) ? value.choices.find(choice => object(choice) && (choice.index ?? 0) === 0) : undefined;
      if (!choice) return;
      const message = choice.delta || choice.message || {};
      state.text += contentText(message.content);
      state.thinking += text(message.reasoning_content || message.reasoning);
      if (message.tool_calls?.length || message.function_call) state.toolCalls = true;
      if (choice.finish_reason) {
        state.finishReason = text(choice.finish_reason);
        finishedChoice = ['stop', 'tool_calls'].includes(choice.finish_reason);
      }
      return;
    }
    if (Array.isArray(value.content)) value.content.forEach(block);
    if (value.type === 'message_start' && Array.isArray(value.message?.content)) value.message.content.forEach(block);
    if (value.type === 'content_block_start') block(value.content_block);
    if (value.type === 'content_block_delta') {
      if (value.delta?.type === 'text_delta') state.text += text(value.delta.text);
      if (value.delta?.type === 'thinking_delta') state.thinking += text(value.delta.thinking);
      if (value.delta?.type === 'input_json_delta') state.toolCalls = true;
    }
    const reason = value.stop_reason || value.delta?.stop_reason;
    if (reason) state.finishReason = text(reason);
    if (value.type === 'message_stop') state.ended = true;
  }
  function flush() {
    if (!data.length) return;
    const payload = data.join('\n'); data = [];
    if (!payload.trim()) return;
    if (payload.trim() === '[DONE]') { state.ended = true; return; }
    try { accept(JSON.parse(payload)); }
    catch { state.error ||= '上游流式数据不完整或格式错误，请查看请求详情。'; }
  }
  function line(value) {
    if (value.endsWith('\r')) value = value.slice(0, -1);
    if (!value) flush();
    else if (value.startsWith('data:')) data.push(value.slice(5).replace(/^ /, ''));
  }
  return {
    push(chunk) {
      buffer += chunk;
      let end;
      while ((end = buffer.indexOf('\n')) !== -1) {
        line(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
      }
      return { ...state };
    },
    finish() {
      if (buffer) { line(buffer); buffer = ''; }
      flush();
      state.ended ||= protocol === 'chat' && finishedChoice;
      return { ...state };
    },
    json(value) {
      accept(value); state.ended = !state.error;
      return { ...state };
    },
    snapshot() { return { ...state }; },
  };
}
