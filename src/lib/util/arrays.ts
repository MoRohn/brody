/**
 * Array helpers that stay safe on very large inputs. `Math.max(...items)` and `target.push(...items)` pass one
 * argument per element, and past roughly a hundred thousand elements the engine throws "Maximum call stack size
 * exceeded". Repository-sized collections (symbols, findings, lines) can reach that, so use these instead.
 */
export function pushAll<T>(target: T[], items: Iterable<T>): T[] {
  for (const item of items) target.push(item);
  return target;
}

/** The largest value, or `floor` if there are none or all are smaller. */
export function maxOf(values: Iterable<number>, floor = -Infinity): number {
  let max = floor;
  for (const v of values) if (v > max) max = v;
  return max;
}
