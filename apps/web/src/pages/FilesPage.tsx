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
 * Upload via file input → base64 (cap 10 MB hiển thị); download/delete;
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
        setError(e instanceof ApiError ? e.message : "Không tải được files");
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
      toast.push("error", "File quá lớn (tối đa 10 MB cho upload từ UI).");
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
        reader.onerror = () => reject(new Error("Không đọc được file"));
        reader.readAsDataURL(file);
      });
      const created = await api.uploadFile(projectId, {
        name: name.trim() || file.name,
        contentBase64: base64,
        mimeType: file.type || undefined,
      });
      setName("");
      setFiles((prev) => (prev ? [created, ...prev] : [created]));
      toast.push("success", `Đã tải “${created.name}” lên.`);
    } catch (e) {
      toast.push("error", e instanceof ApiError ? e.message : "Upload thất bại");
    } finally {
      setUploading(false);
    }
  }

  async function download(f: FileAsset) {
    try {
      await api.downloadFile(f.id, f.name);
    } catch (e) {
      toast.push("error", e instanceof ApiError ? e.message : "Download thất bại");
    }
  }

  async function remove(f: FileAsset) {
    if (!window.confirm(`Xóa file “${f.name}”?`)) return;
    setUseError("");
    try {
      await api.deleteFile(f.id);
      setFiles((prev) => prev?.filter((x) => x.id !== f.id) ?? []);
      toast.push("success", "Đã xóa file.");
    } catch (e) {
      if (e instanceof ApiError && (e.code === "FILE_IN_USE" || e.status === 409)) {
        setUseError(
          `Không xóa được “${f.name}”: file đang được dùng bởi step upload. ${e.message} ` +
            `Hãy sửa các step đó sang file khác trước.`,
        );
        toast.push("error", "File đang được dùng — xem cảnh báo trên bảng.");
      } else {
        toast.push("error", e instanceof ApiError ? e.message : "Xóa thất bại");
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
        Thư viện file cho step <code>Upload</code> (theo fileId). Upload từ máy → base64, tối đa 10 MB/lần hiển thị.
      </p>

      {unsupported ? (
        <EmptyState
          title="Backend chưa hỗ trợ files (API 404)"
          hint="UI đã sẵn sàng theo contract POST/GET /projects/:id/files. Đợi backend P1 wave 2 rồi reload."
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
          <fieldset className="flex flex-wrap items-end gap-2 rounded-lg border border-slate-200 bg-white p-4">
            <Field label="Tên hiển thị (tùy chọn)">
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="vd avatar.png" className="w-52" />
            </Field>
            <Field label="Chọn file (≤ 10 MB)">
              <input
                type="file"
                aria-label="Chọn file tải lên"
                disabled={uploading}
                onChange={(e) => {
                  void onPick(e.target.files?.[0]);
                  e.target.value = "";
                }}
                className="text-xs"
              />
            </Field>
            {uploading ? <p className="text-xs text-slate-500">Đang tải lên…</p> : null}
          </fieldset>

          {useError ? (
            <p role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800">
              {useError}
            </p>
          ) : null}

          {files.length === 0 ? (
            <EmptyState title="Chưa có file" hint="Tải file đầu tiên ở ô phía trên, rồi chọn trong step Upload." />
          ) : (
            <DataTable<FileAsset>
              caption="File library của project"
              emptyText="Chưa có file."
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
                  header: "Đang dùng",
                  render: (r) =>
                    r.usedBy && r.usedBy.length > 0 ? (
                      <span className="block max-w-52 text-[11px] text-slate-600">
                        {r.usedBy.map((u) => u.stepName ?? u.stepId).join(", ")}
                        <span className="block text-slate-400">
                          trong {r.usedBy.map((u) => u.testName ?? u.testId).join(", ")}
                        </span>
                      </span>
                    ) : (
                      <span className="text-xs text-slate-400">—</span>
                    ),
                },
                {
                  key: "id",
                  header: "Thao tác",
                  render: (r) => (
                    <span className="flex gap-2 text-xs">
                      <button className="text-indigo-700 hover:underline" onClick={() => void download(r)}>Tải về</button>
                      <button className="text-red-600 hover:underline" onClick={() => void remove(r)}>Xóa</button>
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
