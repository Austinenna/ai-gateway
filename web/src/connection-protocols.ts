export const protocols = ['chat', 'messages'] as const;
export const protocolName = (protocol: string) => protocol === 'chat' ? 'Chat Completions' : 'Anthropic Messages';
const templates: Record<string, Record<string, string>> = {
  zhipu: { chat: 'https://open.bigmodel.cn/api/paas/v4', messages: 'https://open.bigmodel.cn/api/anthropic/v1' },
  minimax: { chat: 'https://api.minimax.cn/v1', messages: 'https://api.minimax.cn/anthropic/v1' },
  deepseek: { chat: 'https://api.deepseek.com', messages: 'https://api.deepseek.com/anthropic/v1' },
};
export const templateEndpoint = (provider: string, protocol: string) => templates[provider]?.[protocol] || '';
export const connectionProtocols = (connection?: { endpoints?: Record<string, string> }) => protocols.filter(p => !!connection?.endpoints?.[p]);
export const modelProtocols = (model?: { protocols?: string[] }, connection?: { endpoints?: Record<string, string> }) => connectionProtocols(connection).filter(p => model?.protocols?.includes(p));
