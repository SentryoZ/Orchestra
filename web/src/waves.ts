import type { MissionTask } from "./types";

/**
 * Group tasks into dependency waves: everything in a wave can run in parallel.
 * Returns [] when the graph contains a cycle, so callers can flag it.
 */
export function computeWaves(tasks: MissionTask[]): string[][] {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const level = new Map<string, number>();
  const visiting = new Set<string>();
  let cycle = false;

  const depth = (id: string): number => {
    if (level.has(id)) return level.get(id)!;
    if (visiting.has(id)) {
      cycle = true;
      return 0;
    }
    visiting.add(id);
    const deps = (byId.get(id)?.dependsOn ?? []).filter((d) => byId.has(d));
    const v = deps.length ? 1 + Math.max(...deps.map(depth)) : 0;
    visiting.delete(id);
    level.set(id, v);
    return v;
  };

  for (const t of tasks) depth(t.id);
  if (cycle) return [];

  const max = tasks.length ? Math.max(...tasks.map((t) => level.get(t.id) ?? 0)) : -1;
  const waves: string[][] = [];
  for (let i = 0; i <= max; i++) waves.push(tasks.filter((t) => level.get(t.id) === i).map((t) => t.id));
  return waves;
}
