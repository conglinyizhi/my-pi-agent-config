// TODO 调度的纯逻辑：保持 POSIX 路径语义，不依赖 Node、Vue 或本地文件系统。

export function resolveTodoPath(path, cwd = "/") {
  const input = typeof path === "string" ? path : "";
  const base = input.startsWith("/") ? input : `${cwd}/${input.replace(/^\.\//, "")}`;
  const stack = [];
  for (const part of base.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      stack.pop();
      continue;
    }
    stack.push(part);
  }
  return `/${stack.join("/")}`;
}

export function todoBasename(path) {
  const text = typeof path === "string" ? path : "";
  const index = text.lastIndexOf("/");
  return index >= 0 ? text.slice(index + 1) : text;
}

export function displayTodoPath(path, cwd, maxLength = 56) {
  const absolute = resolveTodoPath(path, cwd);
  return absolute.length <= maxLength ? absolute : `…${absolute.slice(-(maxLength - 1))}`;
}

export function toggleTodoSelection(selection, index) {
  const next = new Set(selection);
  next.has(index) ? next.delete(index) : next.add(index);
  return next;
}

export function selectAllTodoIndices(todos, selected) {
  const list = Array.isArray(todos) ? todos : [];
  return selected?.size === list.length && list.length > 0
    ? new Set()
    : new Set(list.map((_, index) => index));
}

export function selectedTodoItems(todos, selection) {
  const list = Array.isArray(todos) ? todos : [];
  return [...(selection || [])].sort((a, b) => a - b).map((index) => list[index]).filter(Boolean);
}
