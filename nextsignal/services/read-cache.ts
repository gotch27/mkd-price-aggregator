// Share unfinished reads regardless of their duration. The freshness window
// starts when the result arrives, so a slow read cannot expire while in flight.
export function createReadCache<T>(ttlMs: number, read: () => Promise<T>) {
  let cached: { expires: number; value: T } | undefined;
  let pending: Promise<T> | undefined;
  return function load(): Promise<T> {
    if (pending) return pending;
    if (cached && cached.expires > Date.now())
      return Promise.resolve(cached.value);
    pending = Promise.resolve()
      .then(read)
      .then((value) => {
        cached = { value, expires: Date.now() + ttlMs };
        return value;
      })
      .finally(() => {
        pending = undefined;
      });
    return pending;
  };
}
