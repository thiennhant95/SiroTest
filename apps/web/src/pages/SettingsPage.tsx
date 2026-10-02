import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ApiError, api, type Environment, type ProjectRecord, type Variable } from "../lib/api";
import { SECRET_MASK } from "../lib/variables";
import { EnvironmentsPanel } from "../components/EnvironmentsPanel";
import {
  Badge,
  DataTable,
  EmptyState,
  ErrorState,
  Select,
  Skeleton,
  useToast,
} from "../components/ui";

/**
 * /settings — environments CRUD + global (shared) variables + retention/limits
 * info (10-ui-ux/screens.md required route). Secrets stay write-only.
 */
export function SettingsPage() {
  const toast = useToast();
  const [projects, setProjects] = useState<ProjectRecord[] | null>(null);
  const [projectId, setProjectId] = useState("");
  const [envs, setEnvs] = useState<Environment[]>([]);
  const [variables, setVariables] = useState<Variable[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        const list = await api.listProjects();
        setProjects(list);
        setProjectId(list[0]?.id ?? "");
      } catch (e) {
        setError(e instanceof ApiError ? e.message : "Không tải được projects");
        setProjects([]);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const reload = async (pid: string) => {
    try {
      const [e, v] = await Promise.all([
        api.listEnvironments(pid),
        api.listVariables(pid),
      ]);
      setEnvs(e);
      setVariables(v);
    } catch (err) {
      toast.push("error", err instanceof ApiError ? err.message : "Không tải được environments/variables");
    }
  };

  useEffect(() => {
    if (projectId) void reload(projectId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  const shared = variables.filter((v) => v.environmentId === null);

  return (
    <main className="mx-auto max-w-4xl space-y-4 p-6">
      <Link to="/projects" className="text-sm text-slate-500 hover:text-slate-800">
        ← Projects
      </Link>
      <h1 className="text-xl font-semibold">Settings</h1>

      {loading ? (
        <div className="space-y-2">
          <Skeleton className="h-10" />
          <Skeleton className="h-24" />
        </div>
      ) : error ? (
        <ErrorState message={error} onRetry={() => window.location.reload()} />
      ) : !projects || projects.length === 0 ? (
        <EmptyState title="Chưa có project" hint="Tạo project qua API rồi quay lại đây." />
      ) : (
        <>
          <label className="block max-w-sm">
            <span className="mb-1 block text-xs font-medium text-slate-600">Project</span>
            <Select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          </label>

          {projectId ? (
            <>
              <section aria-label="Environments" className="rounded-lg border border-slate-200 bg-white">
                <EnvironmentsPanel
                  projectId={projectId}
                  envs={envs}
                  onChanged={() => void reload(projectId)}
                  onClose={() => toast.push("info", "Đóng panel — danh sách đã cập nhật.")}
                />
              </section>

              <section aria-label="Shared variables">
                <h2 className="mb-2 text-sm font-semibold text-slate-700">
                  Biến toàn cục (shared) <Badge>{shared.length}</Badge>
                </h2>
                <DataTable<Variable>
                  caption="Biến dùng chung mọi environment. Secret values are write-only."
                  emptyText="Chưa có biến toàn cục."
                  rows={shared}
                  columns={[
                    { key: "key", header: "Key", render: (v) => <code>{v.key}</code> },
                    {
                      key: "value",
                      header: "Value",
                      render: (v) =>
                        v.isSecret ? <span title="Secret is masked">{SECRET_MASK}</span> : <code>{v.value}</code>,
                    },
                    {
                      key: "isSecret",
                      header: "Type",
                      render: (v) => <Badge tone={v.isSecret ? "amber" : "indigo"}>{v.isSecret ? "secret" : "plain"}</Badge>,
                    },
                  ]}
                />
              </section>
            </>
          ) : null}

          <section aria-label="Retention and limits" className="rounded-lg border border-slate-200 bg-slate-50 p-4">
            <h2 className="mb-2 text-sm font-semibold text-slate-700">
              Retention &amp; giới hạn (admin)
            </h2>
            <ul className="list-disc space-y-1 pl-5 text-xs text-slate-600">
              <li>JSON body tối đa 1 MB · Test definition tối đa 512 KB.</li>
              <li>Mỗi artifact tối đa 50 MB · tối đa 100 screenshots / run.</li>
              <li>Mặc định 1–2 run đồng thời / host; vượt quá sẽ xếp hàng.</li>
              <li>Secret values chỉ resolve lúc run, bị redact khỏi code/logs/events/result JSON.</li>
            </ul>
          </section>
        </>
      )}
    </main>
  );
}
