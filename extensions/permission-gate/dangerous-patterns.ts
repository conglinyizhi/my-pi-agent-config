/**
 * 危险命令模式定义
 *
 * 每个正则匹配一个危险命令类别。添加新类别：push 到数组中即可。
 */
/** 危险命令模式（正则）→ 被阻止时的提示 */
export interface DangerousRule {
  pattern: RegExp;
  /** 被阻止时告知模型的正确做法 */
  tip: string;
  /** 是否自动拒绝（不弹窗问用户）。默认 false = 弹窗确认 */
  autoReject?: boolean;
}

export const dangerousRules: DangerousRule[] = [
  {
    pattern: /(?<!git\s)\brm\s+(-rf?|--recursive)/i,
    tip: "避免递归删除，请先确认目标路径",
  },
  {
    pattern: /\bsudo\b/i,
    tip: "请避免使用 sudo，考虑是否有不需要提权的替代方案",
  },
  {
    pattern: /\b(chmod|chown)\b.*777/i,
    tip: "777 权限过于宽松，请使用更严格的权限设置",
  },
  {
    pattern: /uv\s+pip\s+install.*--system/i,
    tip: "严禁使用 --system 标志，会污染系统 Python 环境。正确做法：先 uv venv 创建虚拟环境，再 uv pip install",
    autoReject: true,
  },
  {
    // 兜底层：任何 uv 命令段（同一分号段内）带 --system 都拦，覆盖顺序/间隔变体
    pattern: /\buv\b[^;]*(?:^|\s)--system\b/i,
    tip: "严禁 uv 使用 --system 标志，会污染系统 Python 环境。正确做法：先 uv venv 创建虚拟环境，再 uv pip install",
    autoReject: true,
  },
  {
    // 排除 uv pip install：uv 自带 venv 隔离、不污染系统（--system 由上面规则单独拦）
    pattern: /(?<!\buv\s)\bpip3?\s+install\b/i,
    tip: "请使用 uv 代替 pip。正确做法：先 uv venv 创建虚拟环境，再 uv pip install",
    autoReject: true,
  },
  {
    pattern: /python3?\s+-m\s+pip\s+install\b/i,
    tip: "请使用 uv 代替 python -m pip。正确做法：先 uv venv 创建虚拟环境，再 uv pip install",
    autoReject: true,
  },
];

/** @deprecated 保留旧接口兼容，新代码请使用 dangerousRules */
export const dangerousPatterns: RegExp[] = dangerousRules.map(r => r.pattern);
