// continuation-message.test.ts — 续跑消息与哨兵单测
//
// 钉住三件事：
//   1. 与业务文本的分界恰好是一个空行（退化成连排会让 bash 出口被当成噪声）
//   2. 哨兵识别必须严格：只认整条命令就是它，不能是「命令里提到过它」——
//      旧实现用 includes 子串匹配，把任何含该字面量的命令（脚本正文、grep）都
//      当成模型报完成，进而 abort 掉正在进行的工作
//   3. 消息里的哨兵与识别器同源
//
// 随机填充本身的测试在 lib/random-filler.test.ts
// 跑法：node --experimental-strip-types lib/continuation-message.test.ts

import assert from "node:assert";
import { describe, it } from "node:test";
import { generateRandomFiller } from "./random-filler.ts";
import { seededRandom } from "./random-filler.test.ts";
import { BASH_HIT, appendLoopBreaker, buildContinueMessage, isBashHitCommand } from "./continuation-message.ts";

describe("appendLoopBreaker（分界契约）", () => {
  it("业务文本与填充之间恰好一个空行", () => {
    const out = appendLoopBreaker("请调用 bash 工具：echo job done already", "河岸 lantern 瓦片");
    assert.strictEqual(out, "请调用 bash 工具：echo job done already\n\n河岸 lantern 瓦片");
    assert.match(out, /\n\n/);
    assert.doesNotMatch(out, /\n\n\n/);
  });

  it("填充为空时原样返回 base（不多出空行）", () => {
    assert.strictEqual(appendLoopBreaker("base", ""), "base");
  });

  it("长填充仍保持单空行分界，业务文本完整保留在最前", () => {
    const base = "请调用 bash 工具：echo job done already";
    const out = appendLoopBreaker(base, generateRandomFiller({ chars: 2000, random: seededRandom(9) }));
    assert.ok(out.startsWith(base + "\n\n"), "出口指令必须完整保留在开头");
    const blankLines = out.split("\n").filter((line) => line === "").length;
    assert.strictEqual(blankLines, 1, "只应有一个空行");
  });
});

describe("isBashHitCommand（哨兵必须整条命令就是它）", () => {
  it("接受哨兵本身与其等价写法", () => {
    for (const cmd of [
      BASH_HIT,
      `  ${BASH_HIT}  `,
      "echo   job   done   already",
      'echo "job done already"',
      "echo 'job done already'",
      `${BASH_HIT};`,
    ]) {
      assert.strictEqual(isBashHitCommand(cmd), true, cmd);
    }
  });

  it("只「提到」哨兵的命令一律不算（旧 includes 实现会误判并 abort 当前工作）", () => {
    const falsePositives = [
      `grep -rn "${BASH_HIT}" lib/`,
      `python3 - <<'PY'\nBASH_HIT = "${BASH_HIT}"\nPY`,
      `echo "${BASH_HIT}" >> notes.md`,
      `${BASH_HIT} && ls`,
      `${BASH_HIT}\nls`,
      `# ${BASH_HIT}`,
      `cd /tmp && ${BASH_HIT}`,
      "echo job done",
      "echo job done already done",
      "true",
      "",
      "   ",
    ];
    for (const cmd of falsePositives) {
      assert.strictEqual(isBashHitCommand(cmd), false, JSON.stringify(cmd));
    }
  });

  it("非字符串输入不抛", () => {
    for (const v of [undefined, null, 42, {}, [], true]) {
      assert.strictEqual(isBashHitCommand(v as unknown), false);
    }
  });

  it("哨兵字面量确在续跑消息里，且消息里的哨兵能被识别器认下（同源）", () => {
    const msg = buildContinueMessage("填充");
    assert.ok(msg.includes(BASH_HIT), "消息必须包含哨兵命令本体");
    assert.ok(isBashHitCommand(BASH_HIT), "消息里的哨兵必须能被识别器认下");
  });
});
