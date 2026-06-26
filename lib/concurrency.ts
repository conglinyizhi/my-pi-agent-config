/**
 * 并发控制工具
 *
 * 提供受最大并发数限制的异步 map 操作。
 */

// ---------------------------------------------------------------------------
// 并发工作线程
// ---------------------------------------------------------------------------

/**
 * 创建并发工作线程——循环从共享索引领取任务并执行。
 *
 * @param nextIndex - 共享的下一个任务索引（会被工作线程递增）
 * @param items     - 待处理数组
 * @param results   - 结果数组（按原索引写入）
 * @param fn        - 单个元素处理函数
 * @returns 工作线程函数（无返回值，执行直到所有任务完成）
 */
export function createConcurrencyWorker<TIn, TOut>(
  nextIndex: { value: number },
  items: TIn[],
  results: TOut[],
  fn: (item: TIn, index: number) => Promise<TOut>,
): () => Promise<void> {
  return async () => {
    while (true) {
      const current = nextIndex.value++;
      if (current >= items.length) return;
      results[current] = await fn(items[current], current);
    }
  };
}

// ---------------------------------------------------------------------------
// 并发 map
// ---------------------------------------------------------------------------

/**
 * 对数组元素并发执行异步操作，并限制最大并发数。
 *
 * 结果顺序与输入数组一致。
 *
 * @param items       - 待处理的数组
 * @param concurrency - 最大并发数（会被限制在 1 ~ items.length）
 * @param fn          - 对每个元素执行的异步函数 `(item, index) => result`
 * @returns 处理结果数组，顺序与输入一致
 */
export async function mapWithConcurrencyLimit<TIn, TOut>(
  items: TIn[],
  concurrency: number,
  fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
  if (items.length === 0) return [];

  const limit = Math.max(1, Math.min(concurrency, items.length));
  const results: TOut[] = new Array(items.length);
  const nextIndex = { value: 0 };

  const workers = new Array(limit).fill(null).map(() =>
    createConcurrencyWorker(nextIndex, items, results, fn),
  );

  await Promise.all(workers);
  return results;
}
