import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { RunProgress } from "../components/RunProgress";
import { ErrorState } from "../components/ui";

function readKnownSecrets(): string[] {
  try {
    const raw = sessionStorage.getItem("vv_known_secrets");
    return raw ? (JSON.parse(raw) as string[]) : [];
  } catch {
    return [];
  }
}

/**
 * /runs/:id — live view.
 * RunProgress subscribes WS (run.queued/started, step.started/passed/failed,
 * run.passed/failed/cancelled) via useRunChannel; DB (GET /runs/:id) is
 * authoritative on (re)connect; Cancel → POST /runs/:id/cancel.
 */
export function RunPage() {
  const { id } = useParams();
  const nav = useNavigate();
  const [knownSecrets] = useState<string[]>(readKnownSecrets);

  if (!id) {
    return (
      <main className="mx-auto max-w-3xl p-6">
        <ErrorState message="Missing run id" onRetry={() => nav("/projects")} />
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-3xl p-6">
      <RunProgress
        runId={id}
        knownSecrets={knownSecrets}
        onBack={() => nav(-1)}
      />
    </main>
  );
}
