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

// 应放行（前面有 venv）——isCommandSafe 先放行，不会走到 autoReject
test("uv venv + pip install", "uv venv && uv pip install requests", true);
test("source activate + pip install", "source .venv/bin/activate && pip install requests", true);
test("python -m venv + pip", "python -m venv .venv && pip install requests", true);

// sudo / rm -rf 不是自动拒绝
test("sudo (not auto-reject)", "sudo apt update", false, false);

console.log("\n完成");
