# 本地技能管理体系

## 目录结构

```
~/.pi/agent/skills/
├── _repo/                        ← git clone 存放
│   ├── .gitignore                ← 忽略所有，仅白名单 repo.toml
│   ├── repo.toml                 ← 技能注册表（被 git 追踪）
│   ├── nopua/                    ← 单技能仓库 clone（被 .gitignore 忽略）
│   ├── moonbit-skills/           ← 多技能聚合仓库 clone（被 .gitignore 忽略）
│   │   └── skills/
│   │       ├── moonbit-orientation/SKILL.md
│   │       └── ...
│   └── base/                     ← 用户自定义技能（非 clone，手动维护）
│       └── my-skill/SKILL.md
├── skill-manager/SKILL.md        ← 本技能（直放，非 git 管理）
├── lazycat-dev/SKILL.md          ← 直放技能
├── pi-docs/SKILL.md
└── data-name/SKILL.md
```

## 核心规则

1. Pi 扫描 `_repo/` 下一级目录，找到 `SKILL.md` 即识别为一个技能
2. 单技能仓库：根目录即技能目录，clone 即可
3. 多技能仓库：clone 后用**相对路径软链接**把子技能目录暴露到 `_repo/` 一级
4. `_repo/repo.toml` 记录来源信息

## 软链接约定

- 必须使用**相对路径**（不用绝对路径，确保目录可整体迁移）：
  ```
  _repo/moonbit-orientation -> moonbit-skills/skills/moonbit-orientation
  ```
- 别名目录名可以和技能名不同：`ln -s moonbit-skills/skills/moonbit-orientation moonbit`
- 已有同名软链接且目标正确 → 跳过；目标错误 → 先删再建
- 已有同名实体目录（非软链接） → 跳过并警告

## `.gitignore` 设计

`_repo/.gitignore` 应设为 `*` 忽略一切，仅白名单 `repo.toml` 和 `.gitignore` 自身：

```
*
!.gitignore
!repo.toml
```

这样 clone 的仓库不会被误加到 Pi 的 git 追踪中，同时 `repo.toml` 可以被版本管理。

## `base/` 目录（用户自定义技能）

`base/` 存放用户自己编写的技能，与 `repo.toml` 管理的第三方技能不同：
- **手动管理**：文件直接放入，不通过 `git clone` 拉取
- **始终激活**：所有条目始终对 Pi 可见，不需要筛选
- 对应软链接：`_repo/<skill-name> -> base/<skill-name>`

## 设计原则（来自 opencode-bl 时代的经验）

- **不污染父仓库**：每个 clone 拥有独立 `.git`，`_repo/.gitignore` 负责隔离
- **相对路径软链接**：不用绝对路径，目录可整体迁移到其他机器
- **repo.toml 是唯一真相源**：跨机器只需 clone + 跑 install.sh 即可重建
