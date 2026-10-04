// Gate 决策摘要的纯展示逻辑：只解释当前请求，不参与权限裁决。

export function gateDecisionSummary({ kind, permission, capability, rules, review } = {}) {
  if (kind === "capability") {
    return { tone: "info", label: "本次能力", text: `仅批准当前命令的 ${capability || "额外"} 能力；worker 重启后仍需逐条审核。` };
  }
  if (kind === "sandbox-allow") {
    if (permission === "full-access") {
      return { tone: "danger", label: "高影响范围", text: "本次会取消文件系统沙箱；仍只执行当前命令，不会改变系统用户身份。" };
    }
    return { tone: "warning", label: "受限升权", text: "本次仅增加列出的可写目录；命令安全审计仍然生效。" };
  }
  const count = Array.isArray(rules) ? rules.length : 0;
  if (review?.verdict === "dangerous") return { tone: "danger", label: "需要人工判断", text: "本地规则和审核模型均指出风险；请先确认命令影响范围。" };
  if (count > 0) return { tone: "warning", label: "需要人工判断", text: `命中 ${count} 项风险规则；允许仅对这次命令生效。` };
  return { tone: "info", label: "需要人工判断", text: "此请求未走自动放行；允许仅对这次命令生效。" };
}
