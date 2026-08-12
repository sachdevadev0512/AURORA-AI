/**
 * Shared async helpers used by sync services and controllers.
 */

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Map `items` with at most `limit` concurrent in-flight `mapper` calls.
 * Optional `shouldAbort()` stops scheduling new work (in-flight work still settles).
 * Optional `options.yieldEvery` + `options.yieldFn` periodically yield the event loop
 * (used by long inventory sync runs).
 */
async function mapWithConcurrency(items, limit, mapper, shouldAbort, options = {}) {
  const list = Array.isArray(items) ? items : [];
  const concurrency = Math.max(1, Number(limit) || 1);
  const results = new Array(list.length);
  let nextIndex = 0;
  let completed = 0;
  const yieldEvery = Number(options.yieldEvery) || 0;
  const yieldFn = typeof options.yieldFn === 'function' ? options.yieldFn : null;

  async function worker() {
    while (nextIndex < list.length) {
      if (typeof shouldAbort === 'function' && shouldAbort()) break;
      const current = nextIndex;
      nextIndex += 1;
      results[current] = await mapper(list[current], current);
      completed += 1;
      if (yieldEvery > 0 && yieldFn && completed % yieldEvery === 0) {
        await yieldFn();
      }
    }
  }

  const workerCount = Math.min(concurrency, list.length);
  if (workerCount === 0) return results;
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

module.exports = {
  sleep,
  mapWithConcurrency,
};
