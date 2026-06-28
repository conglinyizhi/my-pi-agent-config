---
name: data-name
description: 为前端页面重要交互元素标注 data-name 属性，配合 Tampermonkey 用户脚本实现 AI 精准元素定位。用于前端开发、页面调试、bug 复现、UI 自动化场景
---

# data-name 前端元素定位标注

## 概述

现代前端框架（React/Vue/原生）中的 class 名称常被工具链混淆或动态修改，难以作为 AI 定位元素的稳定锚点。`data-name` 属性由开发者显式标注，语义明确、稳定不变，是 AI 与人类之间沟通元素位置的最佳桥梁。

本 skill 提供：
- **标注策略**：指导你为页面元素添加 `data-name` 属性
- **定位工具**：配套 Tampermonkey 用户脚本，点击页面即可生成基于 `data-name` 的 CSS 路径

## 使用场景

以下情况应当启用本 skill：

- 用户需要你分析或修改前端页面的某个元素
- 用户通过截图/视频/文字描述了一个 UI bug，需要定位具体元素
- 你需要为 AI 工具（如 be-read、be-tag-range、be-replace）提供精确的元素选择器
- 用户在前端项目中希望建立可被 AI 理解的元素标识体系

## 标注策略

### 核心原则

- `data-name` 的值表达**元素的语义角色**，而非其在页面中的位置
- 不要添加 `index`、`id`、序号等位置信息——如果用户需要根据位置描述，他们直接用肉眼观察更快
- 命名使用 `kebab-case`

### 标注对象

| 应标注 | 不应标注 |
|--------|---------|
| 交互元素（按钮、输入框、下拉菜单） | 纯装饰元素 |
| 列表容器中的每一项 | 布局容器（除非有语义意义） |
| 弹窗/模态框 | 过多的外层包裹 div |
| 表单字段 | 动态生成的临时节点 |
| 导航/标签页 | 纯文本段落 |

### 命名示例

```html
<!-- 好的命名：语义清晰 -->
<div data-name="user-list">
  <div data-name="user-list-item">用户 1</div>
  <div data-name="user-list-item">用户 2</div>
</div>
<button data-name="submit-btn">提交</button>
<input data-name="search-input" />

<!-- 不要这样：位置信息对 AI 没有意义 -->
<div data-name="user-list-1">...</div>
<div data-name="item-index-3">...</div>
```

### 层级结构

标注应当扁平化，不需要每一层都标注。只标注 AI 可能需要直接引用的层级：

```html
<div data-name="page-container">           <!-- ✅ 需要定位的顶层 -->
  <header>                                  <!-- ❌ 不需要标注 -->
    <nav>
      <button data-name="nav-menu-btn">     <!-- ✅ AI 可能点击 -->
```

## 配套脚本

本 skill 目录附带一个 Tampermonkey 用户脚本 `userscript.user.js`，提供三种工作模式：

### 安装

1. 确保已安装 Tampermonkey 或 Violentmonkey 浏览器扩展
2. 打开 `userscript.user.js` 文件，脚本管理器会自动识别安装
3. 或者手动复制内容新建用户脚本

### 使用方式

通过 Tampermonkey 菜单启动：

| 菜单项 | 模式 | 适用场景 |
|--------|------|---------|
| `🔍 启动元素定位工具` | 单次定位 + 弹窗 | 首次探索页面结构 |
| `⚡ 自动挡` | 带 hover 预览 + 一键复制 | 熟练使用时快速定位 |
| `📝 批量记录模式` | 连续记录多个元素 | 一次定位一组相关元素 |

### 输出格式

单次定位输出（可直接用于 `be-read`、`be-tag-range` 等工具）：

```
div[data-name="page-container"] > section[data-name="content"] > button[data-name="submit-btn"]
```

批量记录输出（自动提取公共父级，差异化部分用 `&` 引用）：

```
/* 公共父级 */
div[data-name="page-container"] > div[data-name="user-list"]

/* 子元素 */
&[data-name="user-list-item"]
&[data-name="user-list-item"]
```
