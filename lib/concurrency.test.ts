import assert from "node:assert";
import { describe, it } from "node:test";
import { mapWithConcurrencyLimit } from "./concurrency.ts";

describe("mapWithConcurrencyLimit", () => {
  it("runs the workers and preserves input order", async () => {
    const result = await mapWithConcurrencyLimit([3, 1, 2], 2, async (n) => {
      await new Promise(resolve => setTimeout(resolve, n * 5));
      return n * 10;
    });
    assert.deepStrictEqual(result, [30, 10, 20]);
  });

  it("caps overlapping work at the concurrency limit", async () => {
    let inFlight = 0;
    let peak = 0;
    await mapWithConcurrencyLimit([1, 2, 3, 4, 5], 2, async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise(resolve => setTimeout(resolve, 10));
      inFlight--;
    });
    assert.strictEqual(peak, 2);
  });
});
