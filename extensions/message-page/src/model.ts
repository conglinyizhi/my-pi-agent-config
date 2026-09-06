// message-page/src/model.ts — 兼容入口
// 模型选择已抽离到 lib/model-selection.ts；保留此导出避免旧引用断裂。
export {
  getAvailableModels,
  modelLabel,
  parseModelSpec,
  pickModel,
  readLastModel,
  resolveModel,
  resolveConfiguredModel,
  selectModel,
  setCurrentSessionModel,
  writeLastModel,
} from "../../../lib/model-selection.ts";
export type {
  LastModel,
  ModelSelectionResult,
  SelectableModel,
} from "../../../lib/model-selection.ts";
