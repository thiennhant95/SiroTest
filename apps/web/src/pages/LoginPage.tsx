import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button, Field, Input, useToast } from "../components/ui";
import { setToken } from "../lib/api";

export function LoginPage() {
  const [userId, setUserId] = useState("tester-1");
  const nav = useNavigate();
  const toast = useToast();

  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-50 p-4">
      <form
        className="w-full max-w-sm space-y-4 rounded-lg border border-slate-200 bg-white p-6 shadow-sm"
        onSubmit={(e) => {
          e.preventDefault();
          if (!userId.trim()) {
            toast.push("error", "Nhập user ID để đăng nhập (P0 dev auth).");
            return;
          }
          // P0 auth (apps/server/src/auth.ts): Bearer token hoặc x-user-id.
          setToken(userId.trim());
          toast.push("success", `Đăng nhập với user “${userId.trim()}”.`);
          nav("/projects");
        }}
      >
        <div>
          <h1 className="text-lg font-semibold">Playwright Studio</h1>
          <p className="text-sm text-slate-500">
            P0 dev login — token lưu ở localStorage, gửi kèm mọi API call.
          </p>
        </div>
        <Field label="User ID">
          <Input value={userId} onChange={(e) => setUserId(e.target.value)} placeholder="tester-1" />
        </Field>
        <Button type="submit" className="w-full">
          Đăng nhập
        </Button>
      </form>
    </main>
  );
}
