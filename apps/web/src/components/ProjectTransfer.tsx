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
      toast.push("success", `Đã tải export của “${projectName ?? projectId}”.`);
    } catch (e) {
      if (isNotImplemented(e)) {
        toast.push("error", "Backend chưa hỗ trợ export (API 404).");
      } else {
        toast.push("error", e instanceof ApiError ? e.message : "Export thất bại");
      }
    } finally {
      setBusy(false);
    }
  }
  return (
    <Button size="sm" variant="outline" disabled={busy} onClick={() => void run()} title="Tải JSON export của project">
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
      toast.push("error", "File export quá lớn (tối đa 1 MB).");
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
        toast.push("error", "File không phải JSON hợp lệ.");
        setBusy(false);
        return;
      }
      const res = await api.importProject({ data });
      setNotice(`Đã tạo project “${res.name ?? res.id}”. Nhớ điền lại secret/variables — chúng không nằm trong file export.`);
      toast.push("success", "Import project thành công.");
      onImported?.(res.id);
    } catch (e) {
      if (isNotImplemented(e)) {
        toast.push("error", "Backend chưa hỗ trợ import (API 404).");
      } else {
        toast.push("error", e instanceof ApiError ? e.message : "Import thất bại");
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
      setError("Dán nội dung .spec.ts trước.");
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
        setError("Backend chưa hỗ trợ import-spec (API 404). UI đã sẵn sàng — đợi backend P1 wave 2.");
      } else {
        setError(e instanceof ApiError ? e.message : "Preview thất bại");
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
      toast.push("success", `Đã tạo test draft “${baseName}”. Kiểm tra steps rồi Save.`);
      onClose();
      nav(`/tests/${created.id}`);
    } catch (e) {
      toast.push("error", e instanceof ApiError ? e.message : "Tạo test thất bại");
    } finally {
      setCreating(false);
    }
  }

  return (
    <Dialog open={open} onClose={onClose} title="Import từ .spec.ts" wide>
      <div className="space-y-3">
        <Field label="Dán nội dung .spec.ts" hint="Parse ở server — preview definition + warnings trước khi tạo.">
          <textarea
            aria-label="Nội dung .spec.ts"
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
            {busy ? "Đang preview…" : "Preview"}
          </Button>
          {preview ? (
            <Button size="sm" disabled={creating} onClick={() => void doCreate()}>
              {creating ? "Đang tạo…" : "Tạo test draft"}
            </Button>
          ) : null}
        </div>
        {preview ? (
          <div className="space-y-2 rounded-md border border-slate-200 bg-slate-50 p-3">
            <p className="text-xs text-slate-700">
              Preview: <strong>{String(preview.definition.name ?? "(chưa đặt tên)")}</strong> ·{" "}
              <Badge>{Array.isArray(preview.definition.steps) ? preview.definition.steps.length : 0} steps</Badge>
            </p>
            {preview.warnings.length > 0 ? (
              <ul className="list-disc space-y-1 pl-5 text-xs text-amber-800">
                {preview.warnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            ) : (
              <p className="text-xs text-green-700">Không có warning — sẵn sàng tạo draft.</p>
            )}
          </div>
        ) : null}
      </div>
    </Dialog>
  );
}
