import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button, Field, Input, Tabs, useToast } from "../components/ui";
import { apiBase, setToken } from "../lib/api";

type Mode = "session" | "register" | "dev";

async function postJson(path: string, body: unknown): Promise<{ ok: boolean; status: number; json: any }> {
  const res = await fetch(`${apiBase}${path}`, {
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
      toast.push("error", isRegister ? "Email + password must be at least 8 characters." : "Enter email + password.");
      return;
    }
    setBusy(true);
    try {
      const path = isRegister ? "/auth/register" : "/auth/login";
      const body = isRegister ? { email: email.trim(), name: name.trim() || undefined, password } : { email: email.trim(), password };
      const r = await postJson(path, body);
      if (!r.ok || !r.json.token) {
        toast.push("error", r.json.message ?? `Log in failed (HTTP ${r.status}).`);
        return;
      }
      done(r.json.token, isRegister ? `Account created for ${r.json.user.email}.` : `Welcome ${r.json.user.email}.`);
    } finally {
      setBusy(false);
    }
  };

  const submitDev = (e: React.FormEvent) => {
    e.preventDefault();
    if (!userId.trim()) {
      toast.push("error", "Enter a user ID to log in (dev auth).");
      return;
    }
    // Dev stub (apps/server/src/auth.ts): user ID làm Bearer token.
    // Tắt hẳn trên host cứng bằng ALLOW_DEV_AUTH=0.
    setToken(userId.trim());
    toast.push("success", `Logged in as dev user "${userId.trim()}".`);
    nav("/projects");
  };

  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-50 p-4">
      <div className="w-full max-w-sm space-y-4 rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
        <div className="flex items-center gap-2">
          <span aria-hidden className="inline-flex h-8 w-8 items-center justify-center rounded-md bg-indigo-600 text-base text-white">▶</span>
          <div>
            <h1 className="text-lg font-semibold leading-tight">Playwright Studio</h1>
            <p className="text-xs text-slate-500">Low-code E2E · JSON is the source of truth</p>
          </div>
        </div>
        <Tabs<Mode>
          value={mode}
          onChange={setMode}
          tabs={[
            { value: "session", label: "Log in" },
            { value: "register", label: "Sign up" },
            { value: "dev", label: "Dev" },
          ]}
        />
        {mode === "dev" ? (
          <form className="space-y-4" onSubmit={submitDev}>
            <Field label="User ID" hint="Dev mode — disabled on hardened hosts via ALLOW_DEV_AUTH=0.">
              <Input value={userId} onChange={(e) => setUserId(e.target.value)} placeholder="tester-1" />
            </Field>
            <Button type="submit" className="w-full" disabled={busy}>
              Log in (dev)
            </Button>
          </form>
        ) : (
          <form className="space-y-4" onSubmit={submitSession}>
            <Field label="Email">
              <Input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="tester@example.com" autoComplete="email" />
            </Field>
            {mode === "register" ? (
              <Field label="Display name (optional)">
                <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Manual Tester" autoComplete="name" />
              </Field>
            ) : null}
            <Field label="Password" hint={mode === "register" ? "At least 8 characters." : undefined}>
              <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete={mode === "register" ? "new-password" : "current-password"} />
            </Field>
            <Button type="submit" className="w-full" disabled={busy}>
              {busy ? "…" : mode === "register" ? "Create account" : "Log in"}
            </Button>
          </form>
        )}
      </div>
    </main>
  );
}
