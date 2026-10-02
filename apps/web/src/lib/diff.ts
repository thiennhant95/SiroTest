interface NamedStep {
  id: string;
  type: string;
  name?: string;
}

function stepsOf(def: unknown): NamedStep[] {
  if (!def || typeof def !== "object") return [];
  const steps = (def as { steps?: unknown }).steps;
  if (!Array.isArray(steps)) return [];
  return steps
    .filter((s): s is Record<string, unknown> => !!s && typeof s === "object")
    .map((s) => ({
      id: String(s["id"] ?? ""),
      type: String(s["type"] ?? "?"),
      name: typeof s["name"] === "string" ? s["name"] : undefined,
    }));
}

export interface StepDiff {
  kind: "added" | "removed" | "renamed";
  id: string;
  detail: string;
}

/** Simple step-level diff for History preview (no JSON wall for testers). */
export function diffSteps(oldDef: unknown, newDef: unknown): StepDiff[] {
  const a = new Map(stepsOf(oldDef).map((s) => [s.id, s]));
  const b = new Map(stepsOf(newDef).map((s) => [s.id, s]));
  const out: StepDiff[] = [];
  for (const [id, nb] of b) {
    const ob = a.get(id);
    if (!ob) out.push({ kind: "added", id, detail: `Thêm bước «${nb.name ?? nb.type}»` });
    else if ((ob.name ?? ob.type) !== (nb.name ?? nb.type))
      out.push({
        kind: "renamed",
        id,
        detail: `Đổi bước: «${ob.name ?? ob.type}» → «${nb.name ?? nb.type}»`,
      });
  }
  for (const [id, ob] of a) {
    if (!b.has(id)) out.push({ kind: "removed", id, detail: `Bỏ bước «${ob.name ?? ob.type}»` });
  }
  return out;
}
