# 权限闸门（Permission Gate）

在执行潜在危险的 bash 命令前请求用户确认。同时支持安全模式白名单，识别常见的无害危险命令组合并自动放行。

## 文件结构

```
permission-gate/
├── index.ts              # 主入口，组装扩展并 export default
├── dangerous-patterns.ts # 危险模式正则定义
├── safe-patterns.ts      # 安全模式白名单处理器
├── helpers.ts            # 切片、查找、判断工具函数
└── README.md             # 本文件
```

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

编辑 `safe-patterns.ts`，push 一个处理器函数：

```ts
(slices) => {
  // 遍历 slices，找到符合安全模式的切片组合
  // 返回被此模式标记为安全的切片索引 Set
  const covered = new Set<number>();
  // ... 匹配逻辑 ...
  return covered;
},
```

处理器签名：`(slices: string[]) => Set<number>`

- `slices`：命令按 `&&` 分割后的字符串数组，已去除空串
- 返回值：被此模式覆盖的切片索引集合（其中包含危险切片索引）

安全模式不需要覆盖该模式涉及的全部切片，只需覆盖**匹配危险模式的那些切片**。
未被安全模式覆盖的危险切片仍会触发确认弹窗。

### 添加新的帮助函数

需要跨模式复用的工具函数放入 `helpers.ts`。

## 安全模式案例

| 命令 | 判定 |
|------|------|
| `cd /tmp && rm -rf mbtest && mkdir mbtest` | ✅ 放行（tmp 重建） |
| `rm -rf /something` | ⚠️ 确认 |
| `rm -rf a && cd /tmp && rm -rf b && mkdir b && rm -rf c` | ⚠️ 确认（a 和 c 未被覆盖） |
