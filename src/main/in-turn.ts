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
