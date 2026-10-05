/** Runs `action` once the one underway under `name` in `queue` is over, however that one ended. */
export function inTurn<T>(queue: Map<string, Promise<unknown>>, name: string, action: () => Promise<T>): Promise<T> {
  const turn = (queue.get(name) ?? Promise.resolve()).catch(() => undefined).then(action);
  queue.set(name, turn);
  const forget = (): void => {
    if (queue.get(name) === turn) {
      queue.delete(name);
    }
  };
  turn.then(forget, forget);
  return turn;
}

/** `fn` over `items` with at most `limit` calls pending at once; results in the order of `items`. */
export async function mapLimited<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await fn(items[index]);
      }
    }),
  );
  return results;
}
