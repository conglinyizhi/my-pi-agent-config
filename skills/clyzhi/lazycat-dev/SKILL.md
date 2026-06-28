---
name: lazycat-dev
description: 懒猫微服开发技能，这个技能不用自己启动，用户会在需要的时候唤醒这个技能在上下文中
---

懒猫开发者文档以静态 Markdown 文件形式托管在官网，可通过 curl 直接获取。

## 文档索引

获取完整文档列表（所有页面标题与路径）：

```bash
curl -s https://developer.lazycat.cloud/llms.txt
```

## 获取具体文档

通过 `llms.txt` 中的路径拼接完整 URL 获取内容：

```bash
# 示例：获取 Hello World 文档
curl -s https://developer.lazycat.cloud/getting-started/hello-world-fast.md

# 示例：获取 LPK 包格式规范
curl -s https://developer.lazycat.cloud/lpk-format.md

# 示例：获取开发环境搭建文档
curl -s https://developer.lazycat.cloud/lzc-cli.md
```

## 高亮文档

> 这个章节下的标题是域名中的相对路径，你多数可以在 llms.txt 中看到这些文档

- /store-submission-guide.md 需要满足这个文章提到的要求，应用才能正常上架，一般这也是开发的核心目标
- /getting-started/dev-workflow.md 官方推荐的应用开发流程
- /publish-app.md 主要是“推送镜像到官方仓库”章节，这里提到可以利用官方镜像仓库来加速用户下载体验，其实这也是审核条件之一
- /resource-skill-mcp.md 在懒猫微服生态中调用其他 skill/mcp 或者提供 skill/mcp 非常有用
- /advanced-oidc.md 对接懒猫微服单点登录/OIDC登录的时有用
- /advanced-inject-passwordless-login.md 免密登录的实现可用思路总览，这是懒猫微服生态应用上架的核心标准

## 一些历史项目的经验

考虑到这部分内容比较多，而且并非每次调用都会用的到，就将这部分内容拆分出来了，如需阅读请参阅技能包下 archive/index.md
