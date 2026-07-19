# 权限闸门（Permission Gate）

在执行潜在危险的 bash 命令前请求用户确认。同时支持安全模式白名单，识别常见的无害危险命令组合并自动放行。

## 文件结构

```
permission-gate/
├── index.ts                  # 主入口，组装扩展并 export default
├── dangerous-patterns.ts     # 危险模式正则定义
├── helpers.ts                # 切片、查找、判断工具函数
├── README.md                 # 本文件
└── safe-patterns/
    ├── index.ts              # 聚合导出 safePatternHandlers
    ├── tmp-recreate.ts       # /tmp 临时目录重建模式
    └── tmp-recreate.test.ts  # 对应测试（27 用例）
```

运行测试：`npx tsx extensions/permission-gate/safe-patterns/tmp-recreate.test.ts`

## 判定流程

```
bash 命令
  │
  ├─ 按 && 分割为切片
  │
  ├─ 逐切片匹配危险模式
  │     │
  │     ├─ 无危险切片 ──────────► 放行
  │     │
  │     └─ 有危险切片
  │           │
  │           ├─ 全部被安全模式覆盖 ──► 放行
  │           │
  │           └─ 存在未被覆盖的 ──► 弹窗确认
  │
  └─ 非交互模式 → 直接阻止（无 UI 无法确认）
```

## 如何扩展

### 添加新的危险模式

编辑 `dangerous-patterns.ts`，push 一个正则：

```ts
// 新增：检测 curl/wget 下载到 /dev/null 以外路径的行为
/\b(curl|wget)\b.*-(o|O)\s+(?!\/dev\/null)/i,
```

### 添加新的安全模式

1. 在 `safe-patterns/` 下创建 `xxx.ts`，导出处理器函数（签名 `SafePatternHandler`）
2. 创建 `xxx.test.ts`，覆盖扫描函数、处理器、端到端三个层级
3. 在 `safe-patterns/index.ts` 中 import 并 push 到 `safePatternHandlers` 数组

推荐使用「分别扫描 + 交叉核对」模式（参考 `tmp-recreate.ts`）：

1. 写扫描函数提取模式相关的切片位置
2. 在处理器中对扫描结果交叉核对（顺序、一致性）
3. 返回覆盖的切片索引 Set

### 添加新的帮助函数

需要跨模式复用的工具函数放入 `helpers.ts`。

## 安全模式案例

| 命令 | 判定 |
|------|------|
| `cd /tmp && rm -rf mbtest && mkdir mbtest` | ✅ 放行（tmp 重建） |
| `rm -rf /something` | ⚠️ 确认 |
| `rm -rf a && cd /tmp && rm -rf b && mkdir b && rm -rf c` | ⚠️ 确认（a 和 c 未被覆盖） |
