/**
 * 工具检测器插件 —— 类型定义
 *
 * 本插件在每次会话启动前检测宿主机上是否安装并配置了某些外部工具（如 gh、glab 等），
 * 若已可用，则在系统提示词中告知大模型优先使用这些 CLI 工具而非直接调用 API。
 *
 * 扩展方式：在 detectors/ 目录下新增一个 .ts 文件，实现 Detector 接口，
 *           然后在 index.ts 的 DETECTORS 数组中注册即可。
 */

// ---------------------------------------------------------------------------
// 公共接口
// ---------------------------------------------------------------------------

/**
 * 单个工具检测器的结果。
 *
 * 所有字段皆为可选 —— 只有检测到有价值的信息时才填充，
 * 避免在提示词中塞入无意义的占位内容。
 */
export interface DetectorResult {
  /** 工具是否已安装（路径可解析） */
  installed: boolean;

  /** 是否已完成鉴权（仅适用于需要登录的 CLI 工具） */
  authenticated?: boolean;

  /** 工具的版本号字符串 */
  version?: string;

  /**
   * 注入到系统提示词中的提示文案。
   *
   * 建议只包含“大模型应该怎么做”的行为指引，例如：
   * "系统已安装 gh CLI 并完成鉴权，需要操作 GitHub 时优先使用 gh 命令而不是 API。"
   *
   * 如果为空字符串或未定义，则不会在提示词中添加任何内容。
   */
  promptHint?: string;
}

/**
 * 工具检测器接口。
 *
 * 每个检测器是一个普通对象，实现 `check()` 方法即可。
 * `check()` 在会话启动时被调用一次，结果会被缓存直到下次会话。
 */
export interface Detector {
  /** 唯一标识，用于日志 & 调试 */
  name: string;

  /**
   * 在 TUI 状态栏中展示的短名称。
   * 若未提供则回退到 `name` 字段。
   * 例如 name="gh-cli" 时可将 displayName 设为 "gh"，让状态栏更简洁。
   */
  displayName?: string;

  /** 人类可读的描述 */
  description: string;

  /**
   * 执行检测逻辑。
   *
   * 实现要点：
   * - 不应该抛出异常；失败时返回 `DetectorResult` 并将 installed 置为 false。
   * - 尽量轻量（只跑 which + auth status 一类命令）。
   */
  check(): Promise<DetectorResult>;
}
