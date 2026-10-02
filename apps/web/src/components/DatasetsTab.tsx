import { useState } from "react";
import { ApiError, api, type DataSet } from "../lib/api";
import { Button, DataTable, Field, Input, Select, useToast } from "./ui";

/**
 * P1 Datasets tab (definition-embedded tables for data-driven runs).
 *
 * - Table preview per dataset reuses DataTable (dynamic columns from headers).
 * - Import: CSV/JSON textarea or file upload → POST /tests/:id/datasets/import.
 * - Delete per dataset. Use `{{row.COLUMN}}` in step values to consume rows;
 *   the run executes the steps once per row (or one row via Run dialog).
 *
 * Security hint (also in generated code): dataset rows are PLAINTEXT embedded
 * in the test definition — never put secrets here, use {{VARIABLES}} instead.
 */
export function DatasetsTab({
  testId,
  datasets,
  onChanged,
}: {
  testId: string;
  datasets: DataSet[];
  onChanged: (definitionJson: unknown) => void;
}) {
  const toast = useToast();
  const [format, setFormat] = useState<"csv" | "json">("csv");
  const [name, setName] = useState("");
  const [content, setContent] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [openId, setOpenId] = useState<string | null>(datasets[0]?.id ?? null);

  async function doImport() {
    if (!content.trim()) {
      setError("Dán nội dung CSV/JSON hoặc tải file lên trước.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const res = await api.importDataset(testId, {
        format,
        ...(name.trim() ? { name: name.trim() } : {}),
        content,
      });
      onChanged(res.definitionJson);
      setOpenId(res.dataset.id);
      setContent("");
      toast.push("success", `Đã import ${res.dataset.rows.length} dòng vào '${res.dataset.name}'.`);
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : "Import thất bại";
      setError(msg);
      toast.push("error", msg);
    } finally {
      setBusy(false);
    }
  }

  async function doDelete(ds: DataSet) {
    if (!window.confirm(`Xóa dataset '${ds.name}' (${ds.rows.length} dòng)?`)) return;
    try {
      const res = await api.deleteDataset(testId, ds.id);
      onChanged(res.definitionJson);
      toast.push("success", `Đã xóa dataset '${ds.name}'.`);
    } catch (e) {
      toast.push("error", e instanceof ApiError ? e.message : "Xóa thất bại");
    }
  }

  function onFile(file: File | undefined) {
    if (!file) return;
    if (file.size > 512 * 1024) {
      setError("File quá lớn (tối đa 512 KB).");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      setContent(String(reader.result ?? ""));
      const lower = file.name.toLowerCase();
      if (lower.endsWith(".json")) setFormat("json");
      else if (lower.endsWith(".csv") || lower.endsWith(".txt")) setFormat("csv");
      if (!name.trim()) {
        setName(file.name.replace(/\.[^.]+$/, "").slice(0, 200));
      }
    };
    reader.readAsText(file);
  }

  return (
    <div className="space-y-3">
      <div className="callout">
        <strong>Bảng dữ liệu chạy lặp (data-driven).</strong> Dùng{" "}
        <code>{"{{row.COLUMN}}"}</code> trong giá trị step để mỗi dòng chạy một lần.{" "}
        <strong>Hàng là chữ thường (plaintext)</strong> — không nhập secret vào đây, hãy dùng{" "}
        <code>{"{{VARIABLES}}"}</code>.
      </div>

      {datasets.length === 0 ? (
        <p className="text-xs text-slate-500">
          Chưa có dataset. Import CSV (dòng đầu là tên cột) hoặc JSON (mảng object) bên dưới.
        </p>
      ) : (
        <ul className="space-y-2">
          {datasets.map((ds) => {
            const headers = Object.keys(ds.rows[0] ?? {});
            const preview = ds.rows.slice(0, 20).map((r, i) => ({ id: `${ds.id}:${i}`, ...r }));
            const open = openId === ds.id;
            return (
              <li key={ds.id} className="rounded-lg border border-slate-200 bg-white">
                <div className="flex flex-wrap items-center gap-2 px-3 py-2">
                  <button
                    type="button"
                    className="text-sm font-semibold text-slate-700 hover:text-indigo-700"
                    onClick={() => setOpenId(open ? null : ds.id)}
                    aria-expanded={open}
                  >
                    {open ? "▾" : "▸"} {ds.name}
                  </button>
                  <span className="text-xs text-slate-500">
                    {ds.rows.length} dòng · cột: {headers.map((h) => `{{row.${h}}}`).join(" ")}
                  </span>
                  <span className="ml-auto">
                    <button
                      type="button"
                      className="text-xs text-red-600 hover:underline"
                      onClick={() => void doDelete(ds)}
                    >
                      Xóa
                    </button>
                  </span>
                </div>
                {open ? (
                  <div className="px-3 pb-3">
                    <DataTable<Record<string, unknown> & { id: string }>
                      caption={`Xem trước ${Math.min(ds.rows.length, 20)}/${ds.rows.length} dòng đầu`}
                      emptyText="Dataset rỗng."
                      rows={preview}
                      columns={[
                        { key: "__idx", header: "#", render: (r) => r.id.split(":")[1] },
                        ...headers.map((h) => ({ key: h, header: h })),
                      ]}
                    />
                    {ds.rows.length > 20 ? (
                      <p className="mt-1 text-xs text-slate-400">
                        Chỉ hiện 20 dòng đầu — toàn bộ {ds.rows.length} dòng vẫn được chạy.
                      </p>
                    ) : null}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      <fieldset className="space-y-2 rounded-lg border border-slate-200 bg-white p-3">
        <legend className="px-1 text-sm font-semibold text-slate-700">Import dataset</legend>
        <div className="flex flex-wrap gap-2">
          <Field label="Định dạng">
            <Select value={format} onChange={(e) => setFormat(e.target.value as "csv" | "json")}>
              <option value="csv">CSV (dòng đầu = tên cột)</option>
              <option value="json">JSON (mảng object)</option>
            </Select>
          </Field>
          <Field label="Tên bảng (tùy chọn)">
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="users"
              className="w-44"
            />
          </Field>
          <Field label="Hoặc tải file">
            <input
              type="file"
              accept=".csv,.txt,.json"
              aria-label="Tải file CSV/JSON"
              onChange={(e) => onFile(e.target.files?.[0])}
              className="text-xs"
            />
          </Field>
        </div>
        <textarea
          aria-label="Nội dung CSV/JSON"
          value={content}
          onChange={(e) => setContent(e.target.value)}
          rows={5}
          spellCheck={false}
          placeholder={format === "csv" ? "EMAIL,CITY\na@example.com,Hanoi" : '[{"EMAIL":"a@example.com","CITY":"Hanoi"}]'}
          className="w-full rounded-md border border-slate-300 p-2 font-mono text-xs"
        />
        {error ? (
          <p role="alert" className="text-xs text-red-700">
            {error}
          </p>
        ) : null}
        <p className="text-xs text-slate-500">
          Tên cột phải khớp <code>/^[A-Za-z_][A-Za-z0-9_]*$/</code> để dùng{" "}
          <code>{"{{row.NAME}}"}</code>; tối đa 500 dòng/bảng, trùng tên sẽ nối thêm dòng.
        </p>
        <Button size="sm" disabled={busy} onClick={() => void doImport()}>
          {busy ? "Đang import…" : "Import"}
        </Button>
      </fieldset>
    </div>
  );
}
