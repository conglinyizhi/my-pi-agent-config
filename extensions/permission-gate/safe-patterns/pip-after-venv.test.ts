import { pipAfterVenv } from "./pip-after-venv";
import { splitSlices, findDangerousSlices, findSafeSlices, isAutoReject } from "../helpers";

function test(label: string, command: string, expectSafe: boolean, expectAutoReject?: boolean) {
  const slices = splitSlices(command);
  const dangerous = findDangerousSlices(slices);
  const safe = findSafeSlices(slices);

  let allCovered = true;
  for (const idx of dangerous) {
    if (!safe.has(idx)) allCovered = false;
  }

  const status = allCovered === expectSafe ? "✓" : "✗";
  const autoStatus = expectAutoReject !== undefined
    ? (isAutoReject(command) === expectAutoReject ? "✓" : "✗ autoReject")
    : "";
  console.log(`${status} ${autoStatus} ${label}: ${command.slice(0,60)}`);
  if (allCovered !== expectSafe) {
    console.log(`  dangerous: ${[...dangerous]}, safe: ${[...safe]}`);
  }
}

// 应被阻止且自动拒绝（没有 venv）
test("bare pip install", "pip install requests", false, true);
test("bare pip3 install", "pip3 install requests", false, true);
test("python -m pip install", "python -m pip install requests", false, true);
test("uv pip install --system", "uv pip install --system requests", false, true);
test("uv pip install --system after pkg", "uv pip install requests --system", false, true);
test("uv pip --system install", "uv pip --system install requests", false, true);
test("uv --system pip install", "uv --system pip install requests", false, true);

// uv pip install 本身不应触发自动拒绝（uv 有隔离保护；--system 单独拦）
test("uv pip install (no venv)", "uv pip install requests", true, false);
test("uv pip install in compound cmd", "cd /tmp && uv pip install requests -q", true, false);

// 应放行（前面有 venv）——isCommandSafe 先放行，不会走到 autoReject
test("uv venv + pip install", "uv venv && uv pip install requests", true);
test("source activate + pip install", "source .venv/bin/activate && pip install requests", true);
test(". activate 简写 + uv pip install", ". .venv/bin/activate && uv pip install requests", true);
test(". activate 简写 + pip install", ". .venv/bin/activate && pip install requests", true);
test("python -m venv + pip", "python -m venv .venv && pip install requests", true);

// venv 激活后带 --system 仍必须拦（白名单不放行 --system）
test("venv + uv pip install --system", "uv venv && uv pip install requests --system", false, true);
test("venv + pip install --system", "uv venv && pip install --system requests", false, true);

// sudo / rm -rf 不是自动拒绝
test("sudo (not auto-reject)", "sudo apt update", false, false);

console.log("\n完成");
