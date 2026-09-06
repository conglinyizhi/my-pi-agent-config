// message-page/src/prefs.ts — 兼容入口
// 模型偏好已随通用模型选择能力抽离到 lib/model-selection.ts。
export {
  pinModel,
  recordModelSelection,
  readLastModel,
  readModelPreferences,
  readScopedModelPreferences,
  unpinModel,
  writeLastModel,
  writeModelPreferences,
} from "../../../lib/model-selection.ts";
export type { LastModel, ModelPreferences, ScopedModelPreferences } from "../../../lib/model-selection.ts";
