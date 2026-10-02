import { createContext, useCallback, useContext, useState } from "react";
import type { ReactNode } from "react";

interface ToastItem {
  id: number;
  message: string;
  kind: "ok" | "err";
}

const ToastCtx = createContext<{ notify: (message: string, kind?: ToastItem["kind"]) => void }>({
  notify: () => {},
});

// eslint-disable-next-line react-refresh/only-export-components
export function useToast() {
  return useContext(ToastCtx);
}

let nextId = 1;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);

  const notify = useCallback((message: string, kind: ToastItem["kind"] = "ok") => {
    const id = nextId++;
    setItems((prev) => [...prev, { id, message, kind }]);
    window.setTimeout(() => {
      setItems((prev) => prev.filter((t) => t.id !== id));
    }, 3600);
  }, []);

  return (
    <ToastCtx.Provider value={{ notify }}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} className={`toast toast-${t.kind}`}>
            {t.message}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}
