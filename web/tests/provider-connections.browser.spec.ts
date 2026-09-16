import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

test('单连接多协议、同一模型别名与协议选择', async ({ page, context }) => {
  const headers = { 'X-Gateway-Admin': '1' };
  const password = 'isolated-ui-test-password-2026';
  const status = await (await page.request.get('/api/status')).json();
  await page.goto('/');
  await page.getByLabel('管理密码', { exact: true }).fill(password);
  if (!status.configured) await page.getByLabel('再次输入密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: status.configured ? (status.locked ? '解锁并进入' : '进入管理页面') : '创建并进入', exact: true }).click();
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const modal = page.getByRole('dialog');
  const chat = () => modal.getByRole('checkbox', { name: 'Chat Completions', exact: true });
  const messages = () => modal.getByRole('checkbox', { name: 'Anthropic Messages', exact: true });
  const chatURL = () => modal.getByLabel('Chat Completions 基础端点');
  const messagesURL = () => modal.getByLabel('Anthropic Messages 基础端点');
  const row = (name: string) => page.locator('.connection-row').filter({ hasText: name });
  const output = resolve('../output/multi-protocol-qa');
  mkdirSync(output, { recursive: true });
  const names = ['双协议表单验证', '仅 Messages 表单验证'];
  let modelID = '', projectID = '';
  const openNew = async () => {
    await page.locator('nav').getByRole('button', { name: /^厂商连接/ }).click();
    await page.getByRole('button', { name: '新增连接', exact: true }).first().click();
  };
  const save = async (name: string) => {
    await modal.getByLabel('连接名称', { exact: true }).fill(name);
    await modal.getByLabel('厂商 Token').fill('fake-multi-protocol-key');
    await modal.getByRole('button', { name: '保存连接', exact: true }).click();
    await expect(modal).toHaveCount(0);
    await expect(row(name)).toBeVisible();
  };
  try {
    await test.step('两个端点独立配置，模板正确且手填地址不因开关丢失', async () => {
      await openNew();
      await messages().check();
      await expect(chatURL()).toHaveValue('https://open.bigmodel.cn/api/paas/v4');
      await expect(messagesURL()).toHaveValue('https://open.bigmodel.cn/api/anthropic/v1');
      await modal.getByRole('combobox', { name: '厂商', exact: true }).selectOption('minimax');
      await expect(chatURL()).toHaveValue('https://api.minimax.cn/v1');
      await expect(messagesURL()).toHaveValue('https://api.minimax.cn/anthropic/v1');
      await modal.getByRole('combobox', { name: '厂商', exact: true }).selectOption('custom');
      await expect(chatURL()).toHaveValue(''); await expect(messagesURL()).toHaveValue('');
      await chatURL().fill('http://127.0.0.1:9/chat/v1');
      await messagesURL().fill('http://127.0.0.1:9/anthropic/v1');
      await messages().uncheck(); await messages().check();
      await expect(messagesURL()).toHaveValue('http://127.0.0.1:9/anthropic/v1');
      for (const [name, width, height, scheme] of [['desktop',1440,1000,'light'], ['mobile',390,844,'light'], ['dark',1440,1000,'dark']] as const) {
        await page.setViewportSize({width,height}); await page.emulateMedia({colorScheme:scheme});
        expect(await modal.evaluate(el => el.scrollWidth <= el.clientWidth+1)).toBe(true);
        await modal.getByRole('button', {name:'保存连接',exact:true}).scrollIntoViewIfNeeded();
        await expect(modal.getByRole('button', {name:'保存连接',exact:true})).toBeInViewport();
        await page.screenshot({path:resolve(output,'connection-'+name+'.png')});
      }
      await page.emulateMedia({colorScheme:'light'});
      await save(names[0]);
      await expect(row(names[0]).getByRole('button', {name:'测试',exact:true})).toHaveCount(0);
      await expect(row(names[0])).toContainText('Chat Completions');
      await expect(row(names[0])).toContainText('Anthropic Messages');
    });
    await test.step('只配 Messages 也能保存，空协议不能保存', async () => {
      await openNew();
      await modal.getByRole('combobox', {name:'厂商',exact:true}).selectOption('custom');
      await chat().uncheck();
      await expect(modal.getByRole('button', {name:'保存连接',exact:true})).toBeDisabled();
      await messages().check();
      await messagesURL().fill('http://127.0.0.1:9/only-messages/v1');
      await save(names[1]);
      await page.reload();
      await page.locator('nav').getByRole('button', {name:/^厂商连接/}).click();
      await row(names[1]).getByRole('button', {name:'编辑',exact:true}).click();
      await expect(chat()).not.toBeChecked(); await expect(messages()).toBeChecked();
      await expect(modal.getByLabel('更换厂商 Token')).toHaveValue('');
      await modal.getByRole('button', {name:'取消',exact:true}).click();
    });
    await test.step('一个模型启用两种协议，测试明确选择协议', async () => {
      const state = await (await page.request.get('/api/admin/state')).json();
      const connection = state.connections.find((c:{name:string}) => c.name===names[0]);
      await page.locator('nav').getByRole('button', {name:/^模型配置/}).click();
      await page.getByRole('button', {name:'新增模型',exact:true}).first().click();
      await modal.getByLabel('显示名称').fill('双协议模型验证');
      await modal.getByLabel('调用别名').fill('dual-protocol-ui');
      await modal.getByRole('combobox', {name:'所属连接',exact:true}).selectOption(connection.id);
      await modal.getByLabel('厂商模型 ID').fill('fake-shared-model');
      await expect(chat()).toBeChecked(); await expect(messages()).toBeChecked();
      await page.screenshot({path:resolve(output,'model-dual.png')});
      await modal.getByRole('button', {name:'保存模型',exact:true}).click();
      await expect(modal).toHaveCount(0);
      const updated = await (await page.request.get('/api/admin/state')).json();
      const model = updated.models.find((m:{alias:string}) => m.alias==='dual-protocol-ui');
      modelID=model.id;
      expect(model.protocols).toEqual(['chat','messages']);
      const tested:string[]=[];
      await page.route('**/api/admin/models/'+modelID+'/test', async route => {
        const protocol=route.request().postDataJSON().protocol; tested.push(protocol);
        await route.fulfill({json:protocol==='chat'?{choices:[{message:{content:'模拟 Chat 成功'}}]}:{type:'message',content:[{type:'text',text:'模拟 Messages 成功'}]}});
      });
      await page.getByRole('row').filter({hasText:'dual-protocol-ui'}).getByRole('button',{name:'测试',exact:true}).click();
      await expect(modal.getByRole('heading')).toContainText('测试模型');
      for (const p of ['chat','messages']) {
        await modal.getByRole('combobox',{name:'测试协议',exact:true}).selectOption(p);
        await modal.getByRole('button',{name:'发起测试',exact:true}).click();
        await expect(modal.locator('pre')).toContainText(p==='chat'?'模拟 Chat 成功':'模拟 Messages 成功');
      }
      expect(tested).toEqual(['chat','messages']);
      await modal.getByRole('button',{name:'关闭',exact:true}).last().click();
    });
    await test.step('同一项目授权与同一别名可复制两种接入配置，并按选择试调用', async () => {
      const created=await page.request.post('/api/admin/projects',{headers,data:{name:'双协议项目验证',enabled:true,model_ids:[modelID]}});
      expect(created.status()).toBe(200); const project=await created.json(); projectID=project.project.id;
      await page.reload();
      await page.locator('nav').getByRole('button',{name:/^项目权限/}).click();
      const projectRow=page.locator('.project-card').filter({hasText:'双协议项目验证'});
      await projectRow.getByRole('button',{name:'接入信息',exact:true}).click();
      for (const p of ['chat','messages']) {
        await modal.getByLabel('客户端协议').selectOption(p);
        await expect(modal.getByLabel('模型别名 Model')).toHaveValue('dual-protocol-ui');
        await modal.getByRole('button',{name:'复制完整接入配置',exact:true}).click();
        await expect(modal.getByRole('status')).toHaveText('接入配置已复制');
        const value=await page.evaluate(()=>navigator.clipboard.readText());
        expect(value===`BASE_URL=http://127.0.0.1:18318${p==='chat'?'/v1':''}\nAPI_KEY=${project.token}\nMODEL=dual-protocol-ui`).toBe(true);
      }
      await modal.getByRole('button',{name:'关闭',exact:true}).click();
      await projectRow.getByRole('button',{name:'试调用',exact:true}).click();
      await modal.getByRole('button',{name:'填入这个项目的凭证',exact:true}).click();
      let trialProtocol='';
      await page.route('**/v1/messages',async route=>{
        trialProtocol='messages'; expect(route.request().postDataJSON().model).toBe('dual-protocol-ui');
        await route.fulfill({contentType:'text/event-stream',body:'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"双协议试调用成功"}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n'});
      });
      await page.getByRole('combobox',{name:'调用协议',exact:true}).selectOption('messages');
      await page.getByRole('button',{name:'发送请求',exact:true}).click();
      await expect(page.locator('.call-output')).toContainText('双协议试调用成功'); expect(trialProtocol).toBe('messages');
    });
  } finally {
    await page.evaluate(()=>navigator.clipboard.writeText(''));
    if(projectID) await page.request.delete('/api/admin/projects/'+projectID,{headers});
    if(modelID) await page.request.delete('/api/admin/models/'+modelID,{headers});
    const state=await (await page.request.get('/api/admin/state')).json();
    for(const c of state.connections.filter((c:{name:string})=>names.includes(c.name))) await page.request.delete('/api/admin/connections/'+c.id,{headers});
  }
});
