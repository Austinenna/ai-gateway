import test from 'node:test';
import assert from 'node:assert/strict';
import { dataFrames, responseText, messageList } from '../src/protocol.mjs';

test('Chat SSE handles CRLF and a partial final event without duplicating output',()=>{
 const a='data: {"choices":[{"delta":{"content":"你"}}]}\r\n\r\n';
 const b='data: {"choices":[{"delta":{"content":"好"}}]}\n\n';
 assert.equal(responseText(a+b.slice(0,20)),'你');
 assert.equal(responseText(a+b+'data: [DONE]\n\n'),'你好');
});
test('Messages text blocks remain separate from thinking blocks',()=>{
 const raw='event: content_block_delta\ndata: {"delta":{"type":"thinking_delta","thinking":"internal"}}\n\nevent: content_block_delta\ndata: {"delta":{"type":"text_delta","text":"answer"}}\n\n';
 assert.equal(responseText(raw),'answer');assert.equal(dataFrames(raw).length,2);
 assert.equal(responseText(JSON.stringify({content:[{type:'thinking',thinking:'internal'},{type:'text',text:'visible'}]})),'visible');
});
test('Structured or malformed upstream content does not become a React object child',()=>{
 assert.equal(responseText('{"choices":[{"message":{"content":[{"type":"text","text":"a"}]}}]}'),'a');
 assert.equal(responseText('{"content":{},"error":{"message":{}}}'),'');
 assert.equal(responseText('not-json'),'');
});
test('Message inspection safely preserves tools and content blocks',()=>{
 const blocks=[{type:'thinking',thinking:'keep'},{type:'tool_use',id:'a',name:'read_file',input:{}}];
 const messages=messageList(JSON.stringify({system:'system',messages:[null,1,{content:'missing role'},{role:'assistant',content:blocks,tool_calls:[{id:'a'}]}],tools:[{name:'read_file'}]}));
 assert.deepEqual(messages.map(x=>x.role),['system','unknown','assistant','tools']);
 assert.deepEqual(messages[2].content,blocks);assert.equal(messages[2].tool_calls[0].id,'a');
 assert.deepEqual(messageList('{"messages":{}}'),[]);assert.deepEqual(messageList('null'),[]);
});
