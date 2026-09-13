// continuation-message.test.ts — 续跑消息与哨兵单测
//
// 钉住四件事：
//   1. 长度达到目标且只追加整词（不切词）
//   2. 中英混合、每次随机、同一随机源下可复现
//   3. 与业务文本的分界恰好是一个空行（退化成连排会让 bash 出口被当成噪声）
//   4. 哨兵识别必须严格：只认整条命令就是它，不能是「命令里提到过它」——
//      旧实现用 includes 子串匹配，把任何含该字面量的命令（脚本正文、grep）都
//      当成模型报完成，进而 abort 掉正在进行的工作
//
// 跑法：node --experimental-strip-types lib/continuation-message.test.ts

import assert from "node:assert";
import { describe, it } from "node:test";
import {
  BASH_HIT,
  DEFAULT_FILLER_CHARS,
  appendLoopBreaker,
  buildContinueMessage,
  generateContinuationFiller,
  isBashHitCommand,
} from "./continuation-message.ts";

/** 可复现的伪随机源（LCG），用于确定性断言 */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

describe("generateContinuationFiller", () => {
  it("达到目标字符数（只追加整词，可能略微超出）", () => {
    const out = generateContinuationFiller({ chars: 500, random: seededRandom(1) });
    assert.ok(out.length >= 500, `期望 >=500，实得 ${out.length}`);
    assert.ok(out.length < 500 + 16, `超出过多：${out.length}`);
  });

  it("缺省长度是 DEFAULT_FILLER_CHARS（很长的一段）", () => {
    const out = generateContinuationFiller({ random: seededRandom(2) });
    assert.ok(out.length >= DEFAULT_FILLER_CHARS);
    assert.ok(DEFAULT_FILLER_CHARS >= 1000, "缺省应该足够长才有打断效果");
  });

  it("中英混合：同一次输出里两种字符都出现", () => {
    const out = generateContinuationFiller({ chars: 400, random: seededRandom(3) });
    assert.match(out, /[\u4e00-\u9fff]/, "应含中文");
    assert.match(out, /[a-z]/, "应含英文");
  });

  it("字符集安全：只有中文、小写英文和分隔空格（无生僻/未分配码位）", () => {
    const out = generateContinuationFiller({ chars: 800, random: seededRandom(4) });
    for (const ch of out) {
      const ok = ch === " " || /[a-z]/.test(ch) || /[\u4e00-\u9fff]/.test(ch);
      assert.ok(ok, `非法字符 ${JSON.stringify(ch)} (U+${ch.codePointAt(0)?.toString(16)})`);
    }
  });

  it("不切词：结尾不是半截（以词或空格收尾，且无连续多空格）", () => {
    const out = generateContinuationFiller({ chars: 300, random: seededRandom(5) });
    assert.doesNotMatch(out, / {2,}/);
    assert.strictEqual(out, out.trim());
  });

  it("同一随机源可复现；不同随机源产出不同", () => {
    const a = generateContinuationFiller({ chars: 300, random: seededRandom(7) });
    const b = generateContinuationFiller({ chars: 300, random: seededRandom(7) });
    const c = generateContinuationFiller({ chars: 300, random: seededRandom(8) });
    assert.strictEqual(a, b);
    assert.notStrictEqual(a, c);
  });

  it("确实是随机的：一段里出现足够多的不同词", () => {
    const out = generateContinuationFiller({ chars: 600, random: seededRandom(11) });
    const distinct = new Set(out.split(" "));
    assert.ok(distinct.size > 20, `不同词只有 ${distinct.size} 个，词池可能被用成常量`);
  });

  it("随机源越界（0 / 1 / NaN）不越位、不抛", () => {
    for (const bad of [() => 0, () => 1, () => Number.NaN, () => -5, () => 99]) {
      const out = generateContinuationFiller({ chars: 120, random: bad });
      assert.ok(out.length >= 120, `random 越界时仍应产出足够长度，实得 ${out.length}`);
      assert.doesNotMatch(out, /undefined/);
    }
  });

  it("chars=0 或负数产出空串（不产生只有空格的串）", () => {
    assert.strictEqual(generateContinuationFiller({ chars: 0 }), "");
    assert.strictEqual(generateContinuationFiller({ chars: -10 }), "");
  });

  it("真实 Math.random 缺省路径可用", () => {
    const out = generateContinuationFiller({ chars: 200 });
    assert.ok(out.length >= 200);
  });
});

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
    const out = appendLoopBreaker(base, generateContinuationFiller({ chars: 2000, random: seededRandom(9) }));
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
