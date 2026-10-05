import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Badge, Button, Dialog, Field, useToast } from "./ui";
import { ApiError, api, isNotImplemented } from "../lib/api";

/** Export button: downloads GET /projects/:id/export?format=json. */
export function ExportProjectButton({ projectId, projectName }: { projectId: string; projectName?: string }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  async function run() {
    setBusy(true);
    try {
      await api.downloadProjectExport(projectId);
      toast.push("success", `Downloaded export of “${projectName ?? projectId}”.`);
    } catch (e) {
      if (isNotImplemented(e)) {
        toast.push("error", "Backend does not support export yet (API 404).");
      } else {
        toast.push("error", e instanceof ApiError ? e.message : "Export failed");
      }
    } finally {
      setBusy(false);
    }
  }
  return (
    <Button size="sm" variant="outline" disabled={busy} onClick={() => void run()} title="Download project JSON export">
      {busy ? "Exporting…" : "⬇ Export"}
    </Button>
  );
}

/**
 * Import button: upload JSON file → POST /projects/import → new project.
 * Secrets are never exported as plaintext, so the UI always reminds testers
 * to re-enter them afterwards.
 */
export function ImportProjectButton({ onImported }: { onImported?: (projectId: string) => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");

  async function onPick(file: File | undefined) {
    if (!file) return;
    if (file.size > 1024 * 1024) {
      toast.push("error", "Export file too large (1 MB max).");
      return;
    }
    setBusy(true);
    setNotice("");
    try {
      const text = await file.text();
      let data: unknown;
      try {
        data = JSON.parse(text);
      } catch {
        toast.push("error", "File is not valid JSON.");
        setBusy(false);
        return;
      }
      const res = await api.importProject({ data });
      setNotice(`Created project “${res.name ?? res.id}”. Remember to re-enter secrets/variables — they are not in the export file.`);
      toast.push("success", "Project imported successfully.");
      onImported?.(res.id);
    } catch (e) {
      if (isNotImplemented(e)) {
        toast.push("error", "Backend does not support import yet (API 404).");
      } else {
        toast.push("error", e instanceof ApiError ? e.message : "Import failed");
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="inline-flex flex-col gap-1">
      <label className="inline-flex h-9 cursor-pointer items-center gap-1.5 rounded-md border border-slate-300 bg-white px-4 text-sm font-medium hover:bg-slate-50">
        {busy ? "Importing…" : "⬆ Import"}
        <input
          type="file"
          accept=".json,application/json"
          aria-label="Import project JSON"
          className="hidden"
          disabled={busy}
          onChange={(e) => {
            void onPick(e.target.files?.[0]);
            e.target.value = "";
          }}
        />
      </label>
      {notice ? (
        <span role="status" className="max-w-64 rounded-md border border-amber-200 bg-amber-50 px-2 py-1 text-[11px] text-amber-800">
          {notice}
        </span>
      ) : null}
    </span>
  );
}

/**
 * Import-spec: paste .spec.ts → POST /projects/:id/import-spec → preview
 * {definition, warnings[]} → create test draft (createTest + saveTest).
 */
export function ImportSpecDialog({ projectId, open, onClose }: { projectId: string; open: boolean; onClose: () => void }) {
  const toast = useToast();
  const nav = useNavigate();
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");
  const [preview, setPreview] = useState<{ definition: { name?: string; steps?: unknown[] } & Record<string, unknown>; warnings: string[] } | null>(null);

  async function doPreview() {
    if (!code.trim()) {
      setError("Paste .spec.ts content first.");
      return;
    }
    setBusy(true);
    setError("");
    setPreview(null);
    try {
      const res = await api.importSpec(projectId, code);
      const def = res.definition as { name?: string; steps?: unknown[] } & Record<string, unknown>;
      setPreview({ definition: def, warnings: res.warnings ?? [] });
    } catch (e) {
      if (isNotImplemented(e)) {
        setError("Backend does not support import-spec yet (API 404). UI is ready — waiting on the P1 wave 2 backend.");
      } else {
        setError(e instanceof ApiError ? e.message : "Preview failed");
      }
    } finally {
      setBusy(false);
    }
  }

  async function doCreate() {
    if (!preview) return;
    setCreating(true);
    try {
      const baseName =
        typeof preview.definition.name === "string" && preview.definition.name.trim()
          ? preview.definition.name.trim()
          : "Imported spec";
      const created = await api.createTest(projectId, baseName);
      await api.saveTest(created.id, preview.definition);
      toast.push("success", `Created test draft “${baseName}”. Review the steps, then save.`);
      onClose();
      nav(`/tests/${created.id}`);
    } catch (e) {
      toast.push("error", e instanceof ApiError ? e.message : "Failed to create test");
    } finally {
      setCreating(false);
    }
  }

  return (
    <Dialog open={open} onClose={onClose} title="Import from .spec.ts" wide>
      <div className="space-y-3">
        <Field label="Paste .spec.ts content" hint="Parsed on the server — preview the definition + warnings before creating.">
          <textarea
            aria-label=".spec.ts content"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            rows={10}
            spellCheck={false}
            placeholder="import { test, expect } from '@playwright/test'; ..."
            className="w-full rounded-md border border-slate-300 p-2 font-mono text-xs"
          />
        </Field>
        {error ? (
          <p role="alert" className="text-xs text-red-700">{error}</p>
        ) : null}
        <div className="flex gap-2">
          <Button size="sm" variant="outline" disabled={busy} onClick={() => void doPreview()}>
            {busy ? "Previewing…" : "Preview"}
          </Button>
          {preview ? (
            <Button size="sm" disabled={creating} onClick={() => void doCreate()}>
              {creating ? "Creating…" : "Create test draft"}
            </Button>
          ) : null}
        </div>
        {preview ? (
          <div className="space-y-2 rounded-md border border-slate-200 bg-slate-50 p-3">
            <p className="text-xs text-slate-700">
              Preview: <strong>{String(preview.definition.name ?? "(untitled)")}</strong> ·{" "}
              <Badge>{Array.isArray(preview.definition.steps) ? preview.definition.steps.length : 0} steps</Badge>
            </p>
            {preview.warnings.length > 0 ? (
              <ul className="list-disc space-y-1 pl-5 text-xs text-amber-800">
                {preview.warnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            ) : (
              <p className="text-xs text-green-700">No warnings — ready to create the draft.</p>
            )}
          </div>
        ) : null}
      </div>
    </Dialog>
  );
}
