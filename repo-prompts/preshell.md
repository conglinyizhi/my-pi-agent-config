# preshell 仓库（repo-prompts 规则）

升级或安装 preshell 二进制走部署侧的 A/B 流程，不要手敲安装命令：

- 装/切：`node ~/.pi/agent/scripts/preshell-install.mjs install --release vX.Y.Z`
  （sha256 校验 → `--spec` 契约门禁 → 切链前影子对比 → 原子切链）
- 回滚/切换：`... use <版本>`；看现状：`... status`
- 二进制在 `~/.pi/runtime/`：按版本存文件，软链 `preshell` 指向当前版

改 pi 侧适配时：`lib/preshell.ts` 的 `EXPECTED_VERSION` 与二进制的主次版号要对得上；
门禁清单在 `scripts/preshell-install.mjs` 的 `GATE`，代码依赖变了要跟着改。
