import { isWebTool } from './web-tools.mjs';

export const protocols = ['chat', 'messages', 'dashscope-asr', 'deepseek-search', 'deepseek-fetch'] as const;
export const protocolName = (protocol: string) => ({ chat: 'Chat Completions', messages: 'Anthropic Messages', 'dashscope-asr': '百炼 ASR', 'deepseek-search': 'DeepSeek 搜索', 'deepseek-fetch': 'DeepSeek 抓取' }[protocol] || protocol);
const templates: Record<string, Record<string, string>> = {
  zhipu: { chat: 'https://open.bigmodel.cn/api/paas/v4', messages: 'https://open.bigmodel.cn/api/anthropic/v1' },
  minimax: { chat: 'https://api.minimax.cn/v1', messages: 'https://api.minimax.cn/anthropic/v1' },
  deepseek: { chat: 'https://api.deepseek.com', messages: 'https://api.deepseek.com/anthropic/v1', 'deepseek-search': 'https://api.deepseek.com/v1', 'deepseek-fetch': 'https://api.deepseek.com/v1' },
  dashscope: { 'dashscope-asr': 'https://dashscope.aliyuncs.com/api/v1' },
};
export const templateEndpoint = (provider: string, protocol: string) => templates[provider]?.[protocol] || '';
export const connectionProtocols = (connection?: { endpoints?: Record<string, string> }): string[] => protocols.filter(p => !!connection?.endpoints?.[p]);
// Search / fetch are separate services: a new model only gets them when ticked explicitly.
export const defaultModelProtocols = (connection?: { endpoints?: Record<string, string> }) => connectionProtocols(connection).filter(p => !isWebTool(p));
export const modelProtocols = (model?: { protocols?: string[] }, connection?: { endpoints?: Record<string, string> }) => connectionProtocols(connection).filter(p => model?.protocols?.includes(p));
