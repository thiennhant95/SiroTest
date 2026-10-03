import { useCallback, useEffect, useState } from "react";
import { api } from "../../api/client";
import { sampleSpecCode } from "../../mocks/sampleVersions";
import { CodeView } from "../../components/CodeView";
import { EmptyState, ErrorState, Skeleton, useToast } from "../../components/ui";
import { buildZip, downloadBlob, specZipFiles } from "../../lib/exportZip";

interface DataSetInfo {
  id: string;
  name: string;
  rows: Record<string, string>[];
}

/**
 * Code tab (Advanced): GET export?format=spec hoặc POST compile.
 * Tester không cần hiểu page.locator() — mọi thứ nằm trong tab riêng này.
 * P1: khi test có datasets, dropdown chọn dataset để preview vòng lặp
 * data-driven (`for (... VV_DATASET_ROWS ...)`); mặc định xem bản P0.
 */
export function CodeTab({ testId, testName }: { testId: string; testName: string }) {
  const toast = useToast();
  const [code, setCode] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [datasets, setDatasets] = useState<DataSetInfo[]>([]);
  const [datasetId, setDatasetId] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      try {
        // Prefer raw export file; fall back to compile JSON.
        setCode(await api.exportSpec(testId, datasetId || undefined));
      } catch {
        const res = await api.compile(testId, datasetId || undefined);
        setCode(res.code);
      }
      try {
        const test = await api.getTest(testId);
        const def = (typeof test.definitionJson === "string"
          ? JSON.parse(test.definitionJson)
          : test.definitionJson) as { datasets?: DataSetInfo[] };
        setDatasets(Array.isArray(def.datasets) ? def.datasets : []);
      } catch {
        /* dataset list optional — preview still works */
      }
    } catch {
      // Offline demo so the tab is still verifiable without backend.
      await new Promise((r) => setTimeout(r, 300));
      setCode(sampleSpecCode);
    } finally {
      setLoading(false);
    }
  }, [testId, datasetId]);

  useEffect(() => {
    void load();
  }, [load]);

  const copy = async () => {
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code);
      toast.push("success", "Đã sao chép mã kiểm thử");
    } catch {
      toast.push("error", "Không sao chép được — hãy bôi đen và Ctrl+C");
    }
  };

  const downloadSpec = () => {
    if (!code) return;
    downloadBlob(new Blob([code], { type: "text/x-typescript" }), `${testId}.spec.ts`);
    toast.push("success", "Đã tải file .spec.ts");
  };

  const downloadZip = () => {
    if (!code) return;
    const zip = buildZip(specZipFiles(testName || testId, code));
    downloadBlob(zip, `${testId}-playwright.zip`);
    toast.push("success", "Đã tải gói ZIP (kèm package.json/config tối thiểu)");
  };

  if (loading) return <Skeleton lines={10} label="Đang sinh mã kiểm thử…" />;
  if (error || code == null)
    return <ErrorState message={error ?? "Không sinh được mã"} onRetry={() => void load()} />;
  if (!code.trim())
    return <EmptyState title="Chưa có mã để hiển thị" hint="Hãy thêm ít nhất một bước rồi quay lại tab Mã." />;

  return (
    <div aria-label="Mã kiểm thử (nâng cao)">
      <div className="callout">
        <strong>Dành cho kỹ thuật.</strong> Tester thao tác ở các tab bên trái là đủ — không cần
        đọc hiểu <code>page.locator()</code>. Mã dưới đây chạy được bằng{" "}
        <code>@playwright/test</code> gốc, không cần Studio.
      </div>
      {datasets.length > 0 ? (
        <label className="row" style={{ display: "flex", gap: 8, alignItems: "center" }}>
          Preview dataset
          <select
            aria-label="Preview dataset"
            value={datasetId}
            onChange={(e) => setDatasetId(e.target.value)}
          >
            <option value="">Không (bản đơn)</option>
            {datasets.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name} ({d.rows.length} dòng)
              </option>
            ))}
          </select>
        </label>
      ) : null}
      <div className="row">
        <button type="button" className="btn" onClick={() => void copy()}>
          Sao chép
        </button>
        <button type="button" className="btn" onClick={downloadSpec}>
          Tải .spec.ts
        </button>
        <button type="button" className="btn" onClick={downloadZip}>
          Tải ZIP
        </button>
        <button type="button" className="btn btn-ghost" onClick={() => void load()}>
          Sinh lại
        </button>
      </div>
      <CodeView code={code} />
      <p className="muted small">
        Chạy ở máy bạn: <code>npm install</code> → <code>npx playwright test</code>. Gói ZIP đã gồm{" "}
        <code>package.json</code> + <code>playwright.config.ts</code> tối thiểu.
      </p>
    </div>
  );
}
