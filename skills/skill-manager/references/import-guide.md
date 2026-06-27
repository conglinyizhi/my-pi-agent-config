# 技能导入流程

## 步骤 1：分析仓库结构

```bash
git clone --depth 1 <repo-url> /tmp/skill-inspect
find /tmp/skill-inspect -maxdepth 3 -name "SKILL.md" | sort
```

根据 `SKILL.md` 的分布判断结构模式：

| 模式 | 特征 | 处理方式 |
|------|------|----------|
| A 单技能 | 根目录有 `SKILL.md` | 直接 clone 到 `_repo/<name>` |
| B 多技能聚合 | `skills/` 下有多个含 `SKILL.md` 的子目录 | clone + 软链接 |
| C 带来源映射 | 有 `skills.sources.json` | 优先按 B 处理，映射文件仅作参考 |
| D 其他 | 不符合上述模式 | 列给用户，人工判断 |

分析完后，读取每个 `SKILL.md` 的 YAML 表头（`name` 和 `description`），列出给用户确认。

## 步骤 2：确认导入范围

列出发现的全部技能，让用户选择：
- 全部导入（`all`）
- 指定技能名（逗号分隔，如 `moonbit-orientation,moonbit-proof`）
- 跳过已存在的同名技能（默认行为）

## 步骤 3：执行导入

### 确保 `.gitignore` 存在

```bash
cd ~/.pi/agent/skills/_repo
# 如果 .gitignore 不存在或为空，写入白名单规则
cat > .gitignore << 'EOF'
*
!.gitignore
!repo.toml
EOF
```

### 多技能聚合仓库（模式 B/C）

```bash
cd ~/.pi/agent/skills/_repo

# 已存在则 git pull，否则 clone
if [ -d "<repo-dir>" ]; then
  cd <repo-dir> && git pull
else
  git clone --depth 1 <repo-url> <repo-dir>
fi

# 为每个选中的子技能创建软链接（相对路径）
cd ~/.pi/agent/skills/_repo
ln -s <repo-dir>/skills/<skill-name> <skill-name>
```

### 单技能仓库（模式 A）

```bash
cd ~/.pi/agent/skills/_repo
if [ -d "<skill-name>" ]; then
  cd <skill-name> && git pull
else
  git clone --depth 1 <repo-url> <skill-name>
fi
```

### 清理

```bash
rm -rf /tmp/skill-inspect
```

## 步骤 4：更新 repo.toml

编辑 `~/.pi/agent/skills/_repo/repo.toml`，追加条目。

### repo.toml 字段说明

| 字段 | 必需 | 说明 |
|------|------|------|
| `name` | 是 | 技能标识名 |
| `source` | 是 | 仓库 URL |
| `description` | 是 | 从 SKILL.md 的 YAML 表头提取 |
| `tags` | 否 | 分类标签 |
| `aliases` | 否 | 别名，如 `["moonbit", "moon"]` |
| `source_dir` | 否 | 当仓库目录名 ≠ name 时，覆盖路径。如 `source_dir = "clyzhi-repo"` |
| `bundle` | 否 | `true` 表示多技能聚合仓库 |
| `link_targets` | 否 | 软链接目标列表（相对于仓库根目录的子路径） |

### 单技能条目

```toml
[[skills]]
name = "<skill-name>"
source = "<repo-url>"
description = "<从 SKILL.md 提取的 description>"
tags = []
```

### 多技能聚合条目

```toml
[[skills]]
name = "<repo-dir>"
source = "<repo-url>"
description = "<一句话描述>"
tags = []
bundle = true
link_targets = [
  "skills/skill-a",
  "skills/skill-b",
]
```

`bundle` 和 `link_targets` 为人工可读标注，Pi 运行时不受其影响（Pi 只扫描 `_repo/` 下的文件层级）。

## 步骤 5：更新已有技能

如果 `_repo/` 下已存在该仓库：

```bash
cd ~/.pi/agent/skills/_repo/<repo-dir>
git pull
```

然后重新检查软链接是否完整（对比 `link_targets` 和实际目录），缺的补上。
