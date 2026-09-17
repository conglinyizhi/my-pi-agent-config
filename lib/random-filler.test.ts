// random-filler.test.ts — 高熵随机填充单测
//
// 钉住四件事：
//   1. 长度达到目标且只追加整词（不切词，半截英文看着像乱码）
//   2. 中英混合、每次随机，同一随机源下可复现
//   3. 字符集安全：只有常用中文、小写英文和分隔空格，无生僻/未分配码位
//   4. 随机源被喂坏值（越界 / NaN）时不越位、不抛
//
// 跑法：node --experimental-strip-types lib/random-filler.test.ts

import assert from "node:assert";
import { describe, it } from "node:test";
import { DEFAULT_FILLER_CHARS, generateRandomFiller } from "./random-filler.ts";

/** 可复现的伪随机源（LCG），用于确定性断言 */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

describe("generateRandomFiller", () => {
  it("达到目标字符数（只追加整词，可能略微超出）", () => {
    const out = generateRandomFiller({ chars: 500, random: seededRandom(1) });
    assert.ok(out.length >= 500, `期望 >=500，实得 ${out.length}`);
    assert.ok(out.length < 500 + 16, `超出过多：${out.length}`);
  });

  it("缺省长度是 DEFAULT_FILLER_CHARS（很长的一段）", () => {
    const out = generateRandomFiller({ random: seededRandom(2) });
    assert.ok(out.length >= DEFAULT_FILLER_CHARS);
    assert.ok(DEFAULT_FILLER_CHARS >= 1000, "缺省应该足够长才有打断效果");
  });

  it("中英混合：同一次输出里两种字符都出现", () => {
    const out = generateRandomFiller({ chars: 400, random: seededRandom(3) });
    assert.match(out, /[\u4e00-\u9fff]/, "应含中文");
    assert.match(out, /[a-z]/, "应含英文");
  });

  it("字符集安全：只有中文、小写英文和分隔空格（无生僻/未分配码位）", () => {
    const out = generateRandomFiller({ chars: 800, random: seededRandom(4) });
    for (const ch of out) {
      const ok = ch === " " || /[a-z]/.test(ch) || /[\u4e00-\u9fff]/.test(ch);
      assert.ok(ok, `非法字符 ${JSON.stringify(ch)} (U+${ch.codePointAt(0)?.toString(16)})`);
    }
  });

  it("不切词：结尾不是半截（以词或空格收尾，且无连续多空格）", () => {
    const out = generateRandomFiller({ chars: 300, random: seededRandom(5) });
    assert.doesNotMatch(out, / {2,}/);
    assert.strictEqual(out, out.trim());
  });

  it("同一随机源可复现；不同随机源产出不同", () => {
    const a = generateRandomFiller({ chars: 300, random: seededRandom(7) });
    const b = generateRandomFiller({ chars: 300, random: seededRandom(7) });
    const c = generateRandomFiller({ chars: 300, random: seededRandom(8) });
    assert.strictEqual(a, b);
    assert.notStrictEqual(a, c);
  });

  it("确实是随机的：一段里出现足够多的不同词", () => {
    const out = generateRandomFiller({ chars: 600, random: seededRandom(11) });
    const distinct = new Set(out.split(" "));
    assert.ok(distinct.size > 20, `不同词只有 ${distinct.size} 个，词池可能被用成常量`);
  });

  it("随机源越界（0 / 1 / NaN）不越位、不抛", () => {
    for (const bad of [() => 0, () => 1, () => Number.NaN, () => -5, () => 99]) {
      const out = generateRandomFiller({ chars: 120, random: bad });
      assert.ok(out.length >= 120, `random 越界时仍应产出足够长度，实得 ${out.length}`);
      assert.doesNotMatch(out, /undefined/);
    }
  });

  it("chars=0 或负数产出空串（不产生只有空格的串）", () => {
    assert.strictEqual(generateRandomFiller({ chars: 0 }), "");
    assert.strictEqual(generateRandomFiller({ chars: -10 }), "");
  });

  it("真实 Math.random 缺省路径可用", () => {
    const out = generateRandomFiller({ chars: 200 });
    assert.ok(out.length >= 200);
  });

  it("两次调用不产出同一段（固定串会被模型记住并忽略）", () => {
    const a = generateRandomFiller({ chars: 800 });
    const b = generateRandomFiller({ chars: 800 });
    assert.notStrictEqual(a, b);
  });
});
