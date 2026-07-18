# git-commit 决策路线

## Refs 信息禁止使用 session id

当前版本原文：

> （如有）Refs 信息禁止使用 session id （看起来就像是一串 uuid）

因为 grok-4.20-non-reasoning 在一次 commit 的过程中塞入了本地 pi 的 session id，但是这东西没办法在其他电脑中作为参考，也没有纳入 git 仓库，这对于后续追踪开发进程毫无帮助，反而会让其他人审阅仓库的时候添乱
