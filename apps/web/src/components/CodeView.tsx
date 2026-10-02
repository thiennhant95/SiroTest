import { useMemo } from "react";

/** Escape HTML then wrap tokens in spans — no heavy lib needed. */
function highlightLine(line: string): string {
  const esc = line
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return esc
    .replace(
      /(\/\/.*)$/,
      `<span class="tok-com">$1</span>`,
    )
    .replace(
      /(&#39;.*?&#39;|&apos;.*?&apos;|'.*?'|`.*?'|&quot;.*?&quot;|".*?")/g,
      `<span class="tok-str">$1</span>`,
    )
    .replace(
      /\b(import|from|test|expect|await|async|const|process|env)\b/g,
      `<span class="tok-kw">$1</span>`,
    );
}

export function CodeView({ code }: { code: string }) {
  const html = useMemo(
    () =>
      code
        .split("\n")
        .map((l) => highlightLine(l) || "&nbsp;")
        .join("\n"),
    [code],
  );
  return (
    <pre className="code" tabIndex={0} aria-label="Mã kiểm thử Playwright">
      <code dangerouslySetInnerHTML={{ __html: html }} />
    </pre>
  );
}
