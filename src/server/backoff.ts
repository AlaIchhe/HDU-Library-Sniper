/** 指数退避：在当前等待时间上翻倍，以 base 起步、max 封顶。 */
export function nextBackoffMs(currentMs: number, baseMs: number, maxMs: number): number {
  const current = Number.isFinite(currentMs) && currentMs > 0 ? currentMs : baseMs;
  return Math.min(Math.max(current * 2, baseMs), maxMs);
}
