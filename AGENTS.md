# 项目接手约定

先读 `README.md` 和 `HANDOFF.md`，再按任务需要查看 `docs/current-architecture.md` 与 `docs/demo.md`。

- 现行方案是 Go＋React／TypeScript＋Vite＋SQLite、首版 LLM、本机运行并为 Linux 准备；`docs/archive/` 仅保留历史方案，不作为当前要求。
- 使用项目脚本构建、启动和测试；前端资源嵌入 Go 二进制，页面改动需要构建后重启才会用于正式启动入口。
- 测试使用临时数据库与模拟上游。不要读取或输出真实 Key，不为验证而删除 `.data/`、重置项目 Token 或调用真实厂商；确需真实联调时按用户当次授权处理。
- 继续沿用已有 Git 历史；正式目录为 `~/Projects/apps/ai-gateway`，不要在旧草稿目录重建副本。
