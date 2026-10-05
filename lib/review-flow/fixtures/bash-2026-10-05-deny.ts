// 由一次运行固化下来的审核轨迹：输入 + 各节点结论 + 最终决定。
// 重放见 lib/review-flow/fixture.test.ts
import type { FlowFixture } from "../fixture.ts";

export const fixture: FlowFixture = {
 "flowId": "bash",
 "capturedAt": "2026-10-05T04:10:00.000Z",
 "input": {
  "command": "sed -i s/a/b/ /etc/hosts",
  "rules": []
 },
 "decision": "deny",
 "via": "deny",
 "nodes": [
  {
   "nodeId": "chat",
   "kind": "chatreview",
   "status": "ran",
   "verdict": "safe",
   "reason": "只读查询，没碰系统文件",
   "to": "classify",
   "calls": 1
  },
  {
   "nodeId": "classify",
   "kind": "classifier",
   "status": "ran",
   "verdict": "risky",
   "reason": "改了 /etc 下的文件",
   "to": "merge",
   "calls": 1
  },
  {
   "nodeId": "merge",
   "kind": "merge",
   "status": "ran",
   "verdict": "risky",
   "reason": "改了 /etc 下的文件",
   "to": "auto"
  },
  {
   "nodeId": "auto",
   "kind": "autoapprove",
   "status": "ran",
   "verdict": "弃权",
   "reason": "判为 risky，需人工确认",
   "to": "gate"
  },
  {
   "nodeId": "gate",
   "kind": "gate",
   "status": "ran",
   "verdict": "deny",
   "reason": "等备份完再说",
   "to": "deny"
  }
 ],
 "note": "分类器判风险、人拒绝的一条：值班时翻这条就知道当时为什么没放行"
};
