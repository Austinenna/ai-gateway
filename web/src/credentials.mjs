export function projectCredentialInput(value) {
  const token = value.trim();
  if (!token) return { token: '', error: '请粘贴完整的项目凭证，或点击「选择项目并填入」。' };
  if (!token.startsWith('gw_')) return { token: '', error: '这里需要以 gw_ 开头的网关项目凭证，不是管理密码或厂商 Token。' };
  if (!/^gw_[A-Za-z0-9_-]{43}$/.test(token)) return { token: '', error: '项目凭证不完整。请复制生成时的完整值，不要填写项目名、凭证前缀或省略号。' };
  return { token, error: '' };
}

// Only retain newly generated credentials in this page's memory. Never persist them.
export function createCredentialMemory() {
  const values = new Map();
  return {
    remember(projectId, token) {
      const checked = projectCredentialInput(token);
      if (projectId && !checked.error) values.set(projectId, checked.token);
    },
    get(projectId) { return values.get(projectId); },
    forget(projectId) { values.delete(projectId); },
    forgetToken(token) {
      for (const [id, value] of values) if (value === token) values.delete(id);
    },
    clear() { values.clear(); },
  };
}
