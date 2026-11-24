/** mulberry32: a seeded generator, so a failing generated case reruns from its seed. */
export function random(seed: number) {
  let state = seed >>> 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
  const int = (below: number): number => Math.floor(next() * below);
  return {
    int,
    chance: (p: number): boolean => next() < p,
    pick: <T>(values: readonly T[]): T => values[int(values.length)] as T,
    shuffle: <T>(values: readonly T[]): T[] => {
      const out = [...values];
      for (let i = out.length - 1; i > 0; i--) {
        const j = int(i + 1);
        [out[i], out[j]] = [out[j] as T, out[i] as T];
      }
      return out;
    },
  };
}
