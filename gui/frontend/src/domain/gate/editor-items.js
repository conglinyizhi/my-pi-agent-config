// 编辑器菜单的条目（纯函数）。
//
// 点"在编辑器打开"时先弹一个菜单让人选：本机有哪些编辑器、各自能干什么，
// 摆成一条条动作。缺字段的动作不出现（没有 left/right 就不给"查看差异"）。

/**
 * @param {{id:string,label:string,canOpen:boolean,canDiff:boolean}[]} editors 主进程探到的
 * @param {{path?:string,line?:number,left?:string,right?:string,patchText?:string}} request
 */
export function editorItems(editors, request = {}) {
  const list = Array.isArray(editors) ? editors : [];
  const items = [];
  for (const editor of list) {
    if (!editor || typeof editor.id !== "string") continue;
    if (editor.canOpen && typeof request.path === "string" && request.path !== "") {
      const at = typeof request.line === "number" && request.line > 0 ? `（第 ${request.line} 行）` : "";
      items.push({
        editorId: editor.id,
        text: `在 ${editor.label} 打开${at}`,
        target: { kind: "open", path: request.path, line: request.line },
      });
    }
    if (editor.canOpen && typeof request.patchText === "string" && request.patchText !== "") {
      items.push({
        editorId: editor.id,
        text: `在 ${editor.label} 打开补丁`,
        target: { kind: "patch", patchText: request.patchText },
      });
    }
    if (editor.canDiff && typeof request.left === "string" && typeof request.right === "string") {
      items.push({
        editorId: editor.id,
        text: `在 ${editor.label} 查看差异`,
        target: { kind: "diff", left: request.left, right: request.right },
      });
    }
  }
  return items;
}
