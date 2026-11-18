// THE CUT OF THE MUTANT GATE INTO SHARDS (scripts/mutants.ts): units (a test file's mutants together, so its setup
// is paid once, or one mutant) by what they cost, heaviest first onto the lightest shard. A shard's planned cost is
// held under `cap`: when `n` shards cannot hold it, more are cut; a unit heavier than a shard's share, or than the
// cap, is dealt out mutant by mutant; a mutant alone over the cap is named, never hidden in a shard.
export interface Unit { key: string; ids: string[]; ms: number[] }

export function cut(units: Unit[], n: number, cap: number): { shards: string[][]; ms: number[]; over: string[] } {
  const total = units.reduce((a, u) => a + u.ms.reduce((x, y) => x + y, 0), 0);
  const singles = units.reduce((a, u) => a + u.ids.length, 0);
  const over = units.flatMap((u) => u.ids.filter((_, i) => u.ms[i]! > cap));
  for (let k = Math.max(1, n, Math.ceil(total / cap)); ; k++) {
    const share = total / k;
    const parts: [string, string[], number][] = [];
    for (const u of units) {
      const w = u.ms.reduce((a, b) => a + b, 0);
      if (w <= Math.min(share, cap)) parts.push([u.key, u.ids, w]);
      else u.ids.forEach((id, i) => parts.push([`${u.key}#${id}`, [id], u.ms[i]!]));
    }
    const weight = Array.from({ length: k }, () => 0);
    const shards: string[][] = Array.from({ length: k }, () => []);
    for (const [, ids, w] of parts.sort((x, y) => y[2] - x[2] || (x[0] < y[0] ? -1 : 1))) {
      const s = weight.indexOf(Math.min(...weight));
      weight[s] += w;
      shards[s]!.push(...ids);
    }
    // A mutant over the cap overflows whatever shard holds it: the cut stops growing once every other shard fits.
    const fits = shards.every((s, i) => weight[i]! <= cap || s.some((id) => over.includes(id)));
    if (fits || k >= singles) return { shards, ms: weight, over };
  }
}
