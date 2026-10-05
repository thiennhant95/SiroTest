import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import {
  Button,
  DataTable,
  EmptyState,
  ErrorState,
  Field,
  Input,
  Skeleton,
  useToast,
} from "../components/ui";
import { ApiError, api, isNotImplemented, type FileAsset } from "../lib/api";

/**
 * P1 wave 2 — File library (/projects/:id/files).
 * Upload via file input → base64 (10 MB UI-upload cap); download/delete;
 * FILE_IN_USE surfaces as a readable alert (never a raw stack).
 */
export function FilesPage() {
  const { id: projectId } = useParams();
  const toast = useToast();
  const [files, setFiles] = useState<FileAsset[] | null>(null);
  const [error, setError] = useState("");
  const [unsupported, setUnsupported] = useState(false);
  const [useError, setUseError] = useState("");

  const [name, setName] = useState("");
  const [uploading, setUploading] = useState(false);

  const load = useCallback(async () => {
    if (!projectId) return;
    setError("");
    setUseError("");
    setUnsupported(false);
    try {
      setFiles(await api.listFiles(projectId));
    } catch (e) {
      if (isNotImplemented(e)) {
        setUnsupported(true);
        setFiles([]);
      } else {
        setError(e instanceof ApiError ? e.message : "Couldn't load files");
        setFiles([]);
      }
    }
  }, [projectId]);

  useEffect(() => {
    setFiles(null);
    void load();
  }, [load]);

  async function onPick(file: File | undefined) {
    if (!file || !projectId) return;
    if (file.size > 10 * 1024 * 1024) {
      toast.push("error", "File too large (10 MB max for UI upload).");
      return;
    }
    setUploading(true);
    try {
      const base64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
          const result = String(reader.result ?? "");
          const comma = result.indexOf(",");
          resolve(comma >= 0 ? result.slice(comma + 1) : result);
        };
        reader.onerror = () => reject(new Error("Couldn't read file"));
        reader.readAsDataURL(file);
      });
      const created = await api.uploadFile(projectId, {
        name: name.trim() || file.name,
        contentBase64: base64,
        mimeType: file.type || undefined,
      });
      setName("");
      setFiles((prev) => (prev ? [created, ...prev] : [created]));
      toast.push("success", `Uploaded “${created.name}”.`);
    } catch (e) {
      toast.push("error", e instanceof ApiError ? e.message : "Upload failed");
    } finally {
      setUploading(false);
    }
  }

  async function download(f: FileAsset) {
    try {
      await api.downloadFile(f.id, f.name);
    } catch (e) {
      toast.push("error", e instanceof ApiError ? e.message : "Download failed");
    }
  }

  async function remove(f: FileAsset) {
    if (!window.confirm(`Delete file “${f.name}”?`)) return;
    setUseError("");
    try {
      await api.deleteFile(f.id);
      setFiles((prev) => prev?.filter((x) => x.id !== f.id) ?? []);
      toast.push("success", "Deleted file.");
    } catch (e) {
      if (e instanceof ApiError && (e.code === "FILE_IN_USE" || e.status === 409)) {
        setUseError(
          `Couldn't delete “${f.name}”: file is used by an upload step. ${e.message} ` +
            `Point those steps at another file first.`,
        );
        toast.push("error", "File is in use — see the warning above the table.");
      } else {
        toast.push("error", e instanceof ApiError ? e.message : "Deletion failed");
      }
    }
  }

  return (
    <main className="mx-auto max-w-4xl space-y-4 p-6">
      <Link to={`/projects/${projectId}`} className="text-sm text-slate-500 hover:text-slate-800">
        ← Project
      </Link>
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Files</h1>
        <span className="flex gap-3 text-sm">
          <Link to={`/projects/${projectId}/profiles`} className="text-indigo-700 hover:underline">Profiles</Link>
          <Link to={`/projects/${projectId}/schedules`} className="text-indigo-700 hover:underline">Schedules</Link>
        </span>
      </div>
      <p className="text-sm text-slate-500">
        File library for the <code>Upload</code> step (by fileId). Upload from your machine → base64, 10 MB max per upload.
      </p>

      {unsupported ? (
        <EmptyState
          title="Backend files not supported (API 404)"
          hint="UI is ready per contract POST/GET /projects/:id/files. Waiting on P1 wave 2 backend — reload later."
        />
      ) : files === null ? (
        <div className="space-y-2">
          <Skeleton className="h-12" />
          <Skeleton className="h-12" />
        </div>
      ) : error ? (
        <ErrorState message={error} onRetry={load} />
      ) : (
        <>
          <fieldset className="flex flex-wrap items-end gap-2 rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
            <Field label="Display name (optional)">
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. avatar.png" className="w-52" />
            </Field>
            <Field label="Choose file (≤ 10 MB)">
              <Input
                type="file"
                aria-label="Choose file to upload"
                disabled={uploading}
                onChange={(e) => {
                  void onPick(e.target.files?.[0]);
                  e.target.value = "";
                }}
                className="cursor-pointer py-1.5 file:mr-3 file:rounded-md file:border-0 file:bg-slate-100 file:px-3 file:py-1.5 file:text-xs file:font-medium file:text-slate-700 hover:file:bg-slate-200"
              />
            </Field>
            {uploading ? <p className="text-xs text-slate-500">Uploading…</p> : null}
          </fieldset>

          {useError ? (
            <p role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800">
              {useError}
            </p>
          ) : null}

          {files.length === 0 ? (
            <EmptyState title="No files yet" hint="Upload your first file above, then pick it in an Upload step." />
          ) : (
            <DataTable<FileAsset>
              caption="Project file library"
              emptyText="No files yet."
              rows={files}
              columns={[
                { key: "name", header: "File", render: (r) => <span className="font-medium">{r.name}</span> },
                {
                  key: "sizeBytes",
                  header: "Size",
                  render: (r) => <span className="text-xs text-slate-600">{formatBytes(r.sizeBytes)}</span>,
                },
                { key: "mimeType", header: "Type", render: (r) => <span className="text-xs">{r.mimeType ?? "—"}</span> },
                {
                  key: "usedBy",
                  header: "In use",
                  render: (r) =>
                    r.usedBy && r.usedBy.length > 0 ? (
                      <span className="block max-w-52 text-[11px] text-slate-600">
                        {r.usedBy.map((u) => u.stepName ?? u.stepId).join(", ")}
                        <span className="block text-slate-400">
                          in {r.usedBy.map((u) => u.testName ?? u.testId).join(", ")}
                        </span>
                      </span>
                    ) : (
                      <span className="text-xs text-slate-400">—</span>
                    ),
                },
                {
                  key: "id",
                  header: "Actions",
                  render: (r) => (
                    <span className="flex gap-1">
                      <Button size="sm" variant="ghost" className="text-indigo-700 hover:text-indigo-900" onClick={() => void download(r)}>Download</Button>
                      <Button size="sm" variant="ghost" className="text-red-600 hover:text-red-800" onClick={() => void remove(r)}>Delete</Button>
                    </span>
                  ),
                },
              ]}
            />
          )}
        </>
      )}
    </main>
  );
}

function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
