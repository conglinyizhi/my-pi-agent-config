import assert from "node:assert";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildInlineScriptRejection, extractInlineScript, saveInlineScript } from "./inline-script.ts";

let pass = 0;
let fail = 0;

function check(name: string, fn: () => void) {
  try {
    fn();
    pass++;
    console.log(`✓ ${name}`);
  } catch (error) {
    fail++;
    console.error(`✗ ${name}: ${(error as Error).message}`);
  }
}

check("提取单引号 Python 代码与字面参数", () => {
  assert.deepStrictEqual(extractInlineScript("python3 -c 'print(42)' hello"), {
    runtime: "python", executable: "python3", code: "print(42)", args: ["hello"],
  });
});

check("提取双引号 Node 代码", () => {
  assert.deepStrictEqual(extractInlineScript('node -e "console.log(42)"'), {
    runtime: "node", executable: "node", code: "console.log(42)", args: [],
  });
});

for (const command of [
  'python3 -c "$CODE"',
  "python3 -c 'print(1)' | cat",
  "cd /tmp && python3 -c 'print(1)'",
  "python3 -c 'print(1)' > out.txt",
  "python3 -c 'print(1)' $(date)",
  "python3 -c 'print(1)' # no extra arguments",
  "python3 -c 'unterminated",
  "env X=1 python3 -c 'print(1)'",
]) {
  check(`拒绝含歧义 shell 结构：${command}`, () => {
    assert.strictEqual(extractInlineScript(command), null);
  });
}

check("以私有权限原样保存并生成清晰拒绝文案", () => {
  const root = mkdtempSync(join(tmpdir(), "inline-script-test-"));
  try {
    const script = extractInlineScript("nodejs -e 'console.log(\"ok\")' --trace-warnings");
    assert(script);
    const saved = saveInlineScript(script, root);
    assert.strictEqual(readFileSync(saved.path, "utf-8"), 'console.log("ok")');
    assert.strictEqual(statSync(join(root, "node-script")).mode & 0o777, 0o700);
    assert.strictEqual(statSync(saved.path).mode & 0o777, 0o600);
    const reason = buildInlineScriptRejection(saved);
    assert.match(reason, /安全闸门拒绝/);
    assert.match(reason, /process\.argv/);
    assert.match(reason, new RegExp(saved.path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

console.log(`\n${pass} 通过, ${fail} 失败`);
if (fail > 0) process.exit(1);
