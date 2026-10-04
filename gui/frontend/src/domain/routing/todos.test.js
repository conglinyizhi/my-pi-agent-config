import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { displayTodoPath, resolveTodoPath, selectAllTodoIndices, selectedTodoItems, todoBasename, toggleTodoSelection } from "./todos.js";

describe("routing TODO domain", () => {
  it("resolves relative and absolute POSIX paths without Node", () => {
    assert.equal(resolveTodoPath("src/../README.md", "/repo/project"), "/repo/project/README.md");
    assert.equal(resolveTodoPath("/repo/../tmp/file", "/ignored"), "/tmp/file");
    assert.equal(resolveTodoPath("../../file", "/repo"), "/file");
    assert.equal(todoBasename("/repo/src/main.go"), "main.go");
    assert.equal(displayTodoPath("a/very/long/path/to/a/file", "/repo", 18), "…ng/path/to/a/file");
  });

  it("returns new immutable selection sets and ordered selected TODOs", () => {
    const initial = new Set([1]);
    const toggled = toggleTodoSelection(initial, 0);
    assert.deepEqual([...initial], [1]);
    assert.deepEqual([...toggled], [1, 0]);
    assert.deepEqual([...selectAllTodoIndices(["a", "b"], toggled)], []);
    const todos = [{ id: "a" }, { id: "b" }, { id: "c" }];
    assert.deepEqual(selectedTodoItems(todos, new Set([2, 0])).map((item) => item.id), ["a", "c"]);
  });
});
