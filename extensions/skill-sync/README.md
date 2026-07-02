# skill-sync

## 功能概述

管理 Pi 技能（skills）的同步与开关。合并了原来的 skill-sync 和 skill-toggle 两个扩展。

- **同步**：session_start 时后台异步同步技能仓库（github clone / 软链接），状态栏实时进度
- **开关**：TUI 循环单选列表，即时启用/禁用技能，支持 bundle（多技能聚合仓库）

## 目录结构

```
~/.pi/agent/
├── skill-repo/     # 纯 clone 存放 + repo.toml 配置
├── skills/         # 软链接 + 直放技能，Pi 扫描此目录
└── skill-states.json  # 技能禁用列表持久化
```

## 提供的命令

### `/skill-manager`

TUI 循环选择列表，展示所有已导入技能及启用状态：
- 单个技能：选中翻转启用/禁用
- 技能组（bundle）：选中翻转全组
- Esc 退出

## 架构

### 文件结构

```
skill-sync/
├── index.ts    # 主入口：同步逻辑、开关命令
└── README.md   # 本文件
```

### 配置格式（repo.toml）

```toml
[[skills]]
name = "skill-name"
source = "https://github.com/user/repo"
# 可选字段：source_dir, description, tags, aliases

# 多技能聚合仓库
[[skills]]
name = "bundle-name"
source = "https://github.com/user/multi-skill-repo"
bundle = true
link_targets = ["subdir1", "subdir2"]
```

### 执行流程

1. **session_start**：解析 repo.toml → 对每个 skill 条目：
   - 已 clone → 确保软链接存在
   - 未 clone → `gh repo clone`（回退 `git clone`）→ 创建软链接
2. 同步完成后：更新状态栏、清理禁用列表中的软链接
3. **skill-manager**：展示所有技能 → 用户选择翻转 → 更新 skill-states.json + 软链接

### 关键设计

- **软链接隔离**：clone 在 skill-repo/，软链接在 skills/，Pi 只扫描 skills/
- **相对路径**：软链接使用相对路径，便于整体移动
- **gh 优先**：使用 `gh repo clone`（已配置密钥），失败回退 `git clone`
- **浅克隆**：`--depth=1` 减少磁盘占用
- **bundle 支持**：一个仓库包含多个技能子目录，通过 `link_targets` 分别链接
- **状态持久化**：禁用列表保存在 skill-states.json，与 repo.toml 独立

### 依赖

- `smol-toml` — TOML 解析
- `gh` CLI — GitHub 仓库克隆（需预先配置密钥）
- `@earendil-works/pi-coding-agent` — getAgentDir
