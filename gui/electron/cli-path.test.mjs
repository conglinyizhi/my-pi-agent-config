import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveCliPath } from "./cli-path.js";

const options = (present) => ({
  here: "/home/u/.pi/runtime/gui/dev/gui/electron",
  env: {},
  home: "/home/u",
  exists: (p) => p === present,
});

describe("数据层 CLI 桥的路径", () => {
  it("槽里没有 scripts/ 时回落到仓库", () => {
    const path = resolveCliPath("flows-cli.ts", options("/home/u/.pi/agent/scripts/flows-cli.ts"));
    assert.equal(path, "/home/u/.pi/agent/scripts/flows-cli.ts");
  });

  it("自己那棵树里有就用它（在仓库里跑时）", () => {
    const own = "/home/u/agent/scripts/flows-cli.ts";
    const path = resolveCliPath("flows-cli.ts", { ...options(own), here: "/home/u/agent/gui/electron" });
    assert.equal(path, own);
  });

  it("PI_AGENT_DIR 指哪就用哪", () => {
    const path = resolveCliPath("flows-cli.ts", {
      ...options("/srv/pi/scripts/flows-cli.ts"),
      env: { PI_AGENT_DIR: "/srv/pi" },
    });
    assert.equal(path, "/srv/pi/scripts/flows-cli.ts");
  });
});
