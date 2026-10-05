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
      toast.push("success", "Copied test code");
    } catch {
      toast.push("error", "Couldn't copy — select all and press Ctrl+C");
    }
  };

  const downloadSpec = () => {
    if (!code) return;
    downloadBlob(new Blob([code], { type: "text/x-typescript" }), `${testId}.spec.ts`);
    toast.push("success", "Downloaded .spec.ts file");
  };

  const downloadZip = () => {
    if (!code) return;
    const zip = buildZip(specZipFiles(testName || testId, code));
    downloadBlob(zip, `${testId}-playwright.zip`);
    toast.push("success", "Downloaded ZIP package (with minimal package.json/config)");
  };

  if (loading) return <Skeleton lines={10} label="Generating test code…" />;
  if (error || code == null)
    return <ErrorState message={error ?? "Couldn't generate code"} onRetry={() => void load()} />;
  if (!code.trim())
    return <EmptyState title="No code to show yet" hint="Add at least one step, then return to the Code tab." />;

  return (
    <div aria-label="Test code (advanced)">
      <div className="callout">
        <strong>For engineers.</strong> Testers can work in the tabs on the left — no need
        to read <code>page.locator()</code>. The code below runs with stock{" "}
        <code>@playwright/test</code>, no Studio needed.
      </div>
      {datasets.length > 0 ? (
        <label className="row" style={{ display: "flex", gap: 8, alignItems: "center" }}>
          Preview dataset
          <select
            aria-label="Preview dataset"
            value={datasetId}
            onChange={(e) => setDatasetId(e.target.value)}
          >
            <option value="">None (single run)</option>
            {datasets.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name} ({d.rows.length} rows)
              </option>
            ))}
          </select>
        </label>
      ) : null}
      <div className="row">
        <button type="button" className="btn" onClick={() => void copy()}>
          Copy
        </button>
        <button type="button" className="btn" onClick={downloadSpec}>
          Download .spec.ts
        </button>
        <button type="button" className="btn" onClick={downloadZip}>
          Download ZIP
        </button>
        <button type="button" className="btn btn-ghost" onClick={() => void load()}>
          Regenerate
        </button>
      </div>
      <CodeView code={code} />
      <p className="muted small">
        Run locally: <code>npm install</code> → <code>npx playwright test</code>. The ZIP already includes{" "}
        <code>package.json</code> + <code>playwright.config.ts</code> minimal.
      </p>
    </div>
  );
}
