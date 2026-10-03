import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button, Field, Input, Tabs, useToast } from "../components/ui";
import { apiBase, setToken } from "../lib/api";

type Mode = "session" | "register" | "dev";

async function postJson(path: string, body: unknown): Promise<{ ok: boolean; status: number; json: any }> {
  const res = await fetch(`${apiBase}/api/v1${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { ok: res.ok, status: res.status, json: await res.json().catch(() => ({})) };
}

export function LoginPage() {
  const [mode, setMode] = useState<Mode>("session");
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [userId, setUserId] = useState("tester-1");
  const [busy, setBusy] = useState(false);
  const nav = useNavigate();
  const toast = useToast();

  const done = (token: string, label: string) => {
    setToken(token);
    toast.push("success", label);
    nav("/projects");
  };

  const submitSession = async (e: React.FormEvent) => {
    e.preventDefault();
    const isRegister = mode === "register";
    if (!email.trim() || password.length < (isRegister ? 8 : 1)) {
      toast.push("error", isRegister ? "Email + mật khẩu ≥ 8 ký tự." : "Nhập email + mật khẩu.");
      return;
    }
    setBusy(true);
    try {
      const path = isRegister ? "/auth/register" : "/auth/login";
      const body = isRegister ? { email: email.trim(), name: name.trim() || undefined, password } : { email: email.trim(), password };
      const r = await postJson(path, body);
      if (!r.ok || !r.json.token) {
        toast.push("error", r.json.message ?? `Đăng nhập thất bại (HTTP ${r.status}).`);
        return;
      }
      done(r.json.token, isRegister ? `Đã tạo tài khoản ${r.json.user.email}.` : `Chào mừng ${r.json.user.email}.`);
    } finally {
      setBusy(false);
    }
  };

  const submitDev = (e: React.FormEvent) => {
    e.preventDefault();
    if (!userId.trim()) {
      toast.push("error", "Nhập user ID để đăng nhập (dev auth).");
      return;
    }
    // Dev stub (apps/server/src/auth.ts): user ID làm Bearer token.
    // Tắt hẳn trên host cứng bằng ALLOW_DEV_AUTH=0.
    setToken(userId.trim());
    toast.push("success", `Đăng nhập dev với user “${userId.trim()}”.`);
    nav("/projects");
  };

  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-50 p-4">
      <div className="w-full max-w-sm space-y-4 rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
        <div>
          <h1 className="text-lg font-semibold">Playwright Studio</h1>
          <p className="text-sm text-slate-500">
            Đăng nhập để lấy session token (lưu ở localStorage, gửi kèm mọi API call).
          </p>
        </div>
        <Tabs<Mode>
          value={mode}
          onChange={setMode}
          tabs={[
            { value: "session", label: "Đăng nhập" },
            { value: "register", label: "Tạo tài khoản" },
            { value: "dev", label: "Dev" },
          ]}
        />
        {mode === "dev" ? (
          <form className="space-y-4" onSubmit={submitDev}>
            <Field label="User ID" hint="Chế độ dev — tắt trên host cứng bằng ALLOW_DEV_AUTH=0.">
              <Input value={userId} onChange={(e) => setUserId(e.target.value)} placeholder="tester-1" />
            </Field>
            <Button type="submit" className="w-full" disabled={busy}>
              Đăng nhập dev
            </Button>
          </form>
        ) : (
          <form className="space-y-4" onSubmit={submitSession}>
            <Field label="Email">
              <Input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="tester@example.com" autoComplete="email" />
            </Field>
            {mode === "register" ? (
              <Field label="Tên hiển thị (tùy chọn)">
                <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Manual Tester" autoComplete="name" />
              </Field>
            ) : null}
            <Field label="Mật khẩu" hint={mode === "register" ? "Tối thiểu 8 ký tự." : undefined}>
              <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete={mode === "register" ? "new-password" : "current-password"} />
            </Field>
            <Button type="submit" className="w-full" disabled={busy}>
              {busy ? "…" : mode === "register" ? "Tạo tài khoản" : "Đăng nhập"}
            </Button>
          </form>
        )}
      </div>
    </main>
  );
}
