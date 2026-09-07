import {
  DeleteSubagentDiagnostic,
  GetInitData,
  GetSubagentDiagnostic,
  GetSubagentDiagnostics,
  GetSubagentStatus,
  GetWindowName,
  LoadReasons,
  MarkReady,
  MergeSubagentSupplements,
  OpenFile,
  QueueSubagentSupplement,
  SaveReason,
  SaveResponse,
  SaveSubagentFeedback,
  WithdrawSubagentSupplement,
} from "../../wailsjs/go/main/App.js";
import { ClipboardSetText, Quit } from "../../wailsjs/runtime/runtime.js";

/**
 * Wails 平台适配器。
 *
 * 它是前端唯一允许接触 Wails generated bindings 的边界。领域视图只依赖这个
 * 普通对象接口；未来浏览器壳可用 HTTP/SSE 实现同名能力而无需改动组件。
 */
export function createWailsPlatform() {
  return {
    session: {
      getWindowName: GetWindowName,
      getInitData: GetInitData,
      markReady: MarkReady,
      async submit(response) {
        await SaveResponse(JSON.stringify(response));
      },
      close: Quit,
    },
    capabilities: {
      openFile: OpenFile,
      copyText: ClipboardSetText,
    },
    gate: {
      loadReasons: LoadReasons,
      saveReason: SaveReason,
    },
    subagents: {
      getStatus: GetSubagentStatus,
      getDiagnostics: GetSubagentDiagnostics,
      getDiagnostic: GetSubagentDiagnostic,
      deleteDiagnostic: DeleteSubagentDiagnostic,
      saveFeedback: SaveSubagentFeedback,
      queueSupplement: QueueSubagentSupplement,
      withdrawSupplement: WithdrawSubagentSupplement,
      mergeSupplements: MergeSubagentSupplements,
    },
  };
}
