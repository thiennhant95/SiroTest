interface NamedStep {
  id: string;
  type: string;
  name?: string;
  raw: Record<string, unknown>;
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
      raw: s,
    }));
}

function stable(v: unknown): string {
  try {
    return JSON.stringify(v ?? null);
  } catch {
    return String(v ?? "");
  }
}

export interface StepDiff {
  kind: "added" | "removed" | "renamed" | "modified";
  id: string;
  detail: string;
}

/** Step-level diff for History preview (no JSON wall for testers). */
export function diffSteps(oldDef: unknown, newDef: unknown): StepDiff[] {
  const a = new Map(stepsOf(oldDef).map((s) => [s.id, s]));
  const b = new Map(stepsOf(newDef).map((s) => [s.id, s]));
  const out: StepDiff[] = [];
  const FIELDS = ["name", "value", "expected", "target", "timeoutMs", "enabled"] as const;
  for (const [id, nb] of b) {
    const ob = a.get(id);
    if (!ob) {
      out.push({ kind: "added", id, detail: `Thêm bước «${nb.name ?? nb.type}»` });
      continue;
    }
    const renamed = (ob.name ?? ob.type) !== (nb.name ?? nb.type);
    const changedFields = FIELDS.filter((f) => stable(ob.raw[f]) !== stable(nb.raw[f]));
    // "renamed" stays for pure name/type changes; anything deeper is "modified".
    if (renamed && changedFields.length <= 1 && changedFields[0] === "name") {
      out.push({
        kind: "renamed",
        id,
        detail: `Đổi bước: «${ob.name ?? ob.type}» → «${nb.name ?? nb.type}»`,
      });
    } else if (changedFields.length > 0) {
      const listed = changedFields
        .map((f) => {
          if (f === "target") return `target: ${stable(ob.raw.target)} → ${stable(nb.raw.target)}`;
          return `${f}: ${stable(ob.raw[f])} → ${stable(nb.raw[f])}`;
        })
        .join("; ");
      out.push({ kind: "modified", id, detail: `Sửa bước «${nb.name ?? nb.type}» (${listed})` });
    }
  }
  for (const [id, ob] of a) {
    if (!b.has(id)) out.push({ kind: "removed", id, detail: `Bỏ bước «${ob.name ?? ob.type}»` });
  }
  return out;
}
