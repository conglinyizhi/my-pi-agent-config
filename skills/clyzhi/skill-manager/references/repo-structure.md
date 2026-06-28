# 本地技能管理体系

## 目录结构

```
~/.pi/agent/
├── skill-repo/                   ← git clone 存放 + repo.toml
│   ├── repo.toml                 ← 技能注册表（git 追踪）
│   ├── nopua/                    ← 单技能仓库 clone
│   ├── moonbit-skills/           ← 多技能聚合仓库 clone
│   │   └── skills/
│   │       ├── moonbit-orientation/SKILL.md
│   │       └── ...
│   └── ...
│
├── skills/                       ← Pi 扫描此目录（递归）
│   ├── clyzhi/                   ← 用户自有技能（git 追踪）
│   │   ├── skill-manager/SKILL.md
│   │   ├── pi-docs/SKILL.md
│   │   ├── data-name/SKILL.md
│   │   └── lazycat-dev/SKILL.md
│   ├── nopua -> ../skill-repo/nopua          ← 软链接（git 忽略）
│   ├── moonbit-orientation -> ../skill-repo/moonbit-skills/skills/moonbit-orientation
│   └── ...
│
└── .gitignore                    ← 忽略 skill-repo/* 和 skills/*（白名单 skills/clyzhi/）
```

## 核心规则

1. Pi 扫描 `skills/` 目录（递归），找到 `SKILL.md` 即识别为一个技能
2. `skill-repo/` 纯放 clone + repo.toml，不和软链接混放
3. 单技能仓库：clone 后通过软链接 `skills/<name> -> ../skill-repo/<name>` 暴露
4. 多技能仓库（bundle）：clone 后为每个 `link_target` 创建软链接
5. `skill-repo/repo.toml` 记录来源信息

## 软链接约定

- 必须使用**相对路径**，确保目录可整体迁移：
  ```
  skills/nopua -> ../skill-repo/nopua
  skills/moonbit-orientation -> ../skill-repo/moonbit-skills/skills/moonbit-orientation
  ```
- 已有同名软链接且目标正确 → 跳过；目标错误 → 先删再建
- 已有同名实体目录（非软链接） → 跳过并警告

## `.gitignore` 设计

项目根 `.gitignore`：

```
skill-repo/*           ← 忽略 clone，只追踪 repo.toml
!skill-repo/repo.toml
skills/*               ← 忽略所有软链接
!skills/clyzhi/        ← 白名单：用户自有技能
```

## `skills/clyzhi/` 目录（用户自有技能）

- **手动管理**：文件直接放入，不通过 `git clone` 拉取
- **始终激活**：Pi 递归扫描 `skills/`，子目录自动发现
- **git 追踪**：通过 `.gitignore` 白名单保护
- 无需软链接，Pi 直接扫描子目录

## 设计原则

- **clone 与软链接分离**：`skill-repo/` 只放实体，`skills/` 只放软链接
- **相对路径软链接**：不用绝对路径，目录可整体迁移
- **repo.toml 是唯一真相源**：跨机器只需 clone + 跑 install.sh 即可重建
