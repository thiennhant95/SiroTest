# Gherkin tiếng Việt — Implementation Plan

Ngày: 2026-10-06. Trạng thái: planned. Mục tiêu: tester viết `Cho rằng/Khi/Thì`
trong tab Builder → parse deterministic (rules, không LLM) → preview steps →
chèn vào test (mint version như mọi save khác).

Không tự chạy, không tự sửa definition. Unparse được trả về显式, không bịa step.

## 1. Cú pháp (subset, deterministic)

```gherkin
@smoke @login
Tính năng: Đăng nhập admin
  Bối cảnh:
    Cho rằng mở trang https://test.aloa.asia/admin/login
  Kịch bản: Login thành công
    Khi nhập "Email Address" là "admin@x.io"
    Và nhập "Password" là "123456"
    Và bấm nút "Sign In"
    Thì kiểm tra "Dashboard" hiển thị
  Kịch bản: Login sai mật khẩu
    Khi nhập "Mật khẩu" là "sai"
    Và nhấn "Sign In"
    Thì kiểm tra "Email hoặc mật khẩu không đúng" hiển thị
```

Từ khóa (không phân biệt hoa/thường, chấp nhận có/không dấu `:` cuối dòng):

| Loại | VI | EN fallback |
|---|---|---|
| Feature | `Tính năng:`, `Chức năng:` | `Feature:` |
| Background | `Bối cảnh:` | `Background:` |
| Scenario | `Kịch bản:`, `Tình huống:` | `Scenario:`, `Example:` |
| Given | `Cho rằng`, `Giả sử`, `Với` | `Given` |
| When | `Khi` | `When` |
| Then | `Thì`, `Vậy thì` | `Then` |
| And | `Và` | `And` |
| But | `Nhưng` | `But` |
| Tags | `@tag` đầu dòng Feature/Scenario | — |
| Comment | dòng bắt đầu `#` → bỏ qua | — |

Luật:
- Dòng step = `<Từ khóa> <mệnh đề>`. `Và`/`Nhưng` kế thừa loại của step
  trước đó trong cùng block (Given/When/Then đầu block thiếu → unparsed).
- `Bối cảnh:` áp cho MỌI scenario (steps chèn đầu mỗi scenario).
- Bảng `| Ví dụ: |` (Examples + data table): NGOÀI PHẠM VI đợt này —
  parser gặp dòng `|` hoặc từ khóa `Ví dụ:` thì dòng đó unparsed (không fail cả bài).
- Nhiều `Kịch bản:` trong 1 text: đợt này chỉ lấy scenario ĐẦU TIÊN,
  các scenario sau trả vào `warnings[]` (không parse, không mất).
- Tags `@a @b` gom vào `tags[]` (để UI/filter dùng sau, không ép vào definition).

## 2. Mapping mệnh đề → step

Mệnh đề (sau khi lột từ khóa) tái dùng matcher của `nl-to-steps`
(phải tách `parseNlClause(clause): LooseStep | null` ra khỏi pipeline nội bộ).
Không match → dòng đó vào `unparsed[]` (ghi rõ số dòng).

Ví dụ mapping kỳ vọng:
- `mở trang https://…` → goto
- `nhập "X" là "Y"` / `nhập X là Y` / `điền email a@x.io` → fill
- `bấm nút "X"` / `nhấn "X"` / `click nút X` → click
- `chọn "A" trong ô "B"` → select · `chờ N giây` → waitForTimeout
- `đợi "X" hiện ra` → waitForElement · `kiểm tra "X" hiển thị` → assertVisible
- `kiểm tra URL chứa "…"` → assertURL · `kiểm tra tiêu đề là "…"` → assertTitle
- `chụp màn hình` → screenshot · `tải lại trang` → reload · `nhấn phím Enter` → press

Step id: `g1`, `g2`, … (prefix `g`, counter riêng, reset được cho test).
Mọi step emit PHẢI qua `testStepSchema.safeParse` (pattern `pushIfValid` có sẵn):
fail schema → unparsed, không bao giờ emit step invalid.

## 3. Contract chia việc (4 agent, file không overlap)

### Agent A — Parser (`packages/ai/`)
- Mới: `packages/ai/src/gherkin-vi.ts`
  `export interface GherkinViResult { steps: LooseStep[]; unparsed: string[]; warnings: string[]; scenarioName?: string; tags: string[] }`
  `export function gherkinViToSteps(text: string): GherkinViResult`
- Sửa tối thiểu `packages/ai/src/nl-to-steps.ts`: export
  `parseNlClause(clause: string): LooseStep | null` (tách từ MATCHERS pipeline,
  giữ nguyên hành vi `nlToSteps`), export type `LooseStep` nếu chưa export.
- Sửa `packages/ai/src/index.ts`: `export * from "./gherkin-vi.js";`
- Test mới `packages/ai/tests/gherkin-vi.test.ts` (vitest): full login flow VI
  (background + 2 scenarios → scenario đầu đủ steps, scenario 2 vào warnings),
  EN fallback, `Và` kế thừa sai block → unparsed, Examples/table → unparsed,
  tags gom đủ, `assertAllValid` mọi step emit, determinism (gọi 2 lần bằng nhau).
- Verify: `pnpm --filter @vv/ai test` + `pnpm --filter @vv/ai build`.

### Agent B — API (`apps/server/`)
- Sửa `apps/server/src/routes/ai.ts`: thêm
  `POST /ai/gherkin` body `{ text: string(1..8000), projectId?: string }`
  → `{ engine: 'rules', steps, unparsed, warnings, scenarioName?, tags }`
  (gọi `gherkinViToSteps` từ `@vv/ai`; KHÔNG persist gì).
  Guard: `projectId` có → `requireReadAccessToProject` (đã có helper trong rbac.ts).
  `aiRoutes` đã register trong app.ts — không đụng app.ts.
- Verify: `pnpm --filter @vv/server typecheck`, tự test bằng tsx hoặc curl
  sau build (server dist mới): 1 text mẫu → đủ steps.

### Agent C — UI (`apps/web/`)
- Mới `apps/web/src/components/GherkinTab.tsx`: textarea + nút "Phân tích" +
  preview steps (type + name) + dòng unparsed đỏ + nút "Chèn vào cuối test"
  (append steps vào definition hiện tại rồi PATCH `/tests/:id` như flow save
  thường — tự đọc BuilderPage/SuggestionsPanel để tái dùng pattern load+PATCH).
- Sửa `apps/web/src/api/p2.ts`: thêm `parseGherkin(text, projectId?)`.
- Sửa `apps/web/src/pages/BuilderPage.tsx`: thêm bottom tab `"gherkin"`
  cạnh `"suggest"` (type BottomTab + tabs[] + render panel).
- Verify: `pnpm --filter @playwright-studio/web typecheck`.

### Agent D — Verify + docs (chạy SAU khi A+B+C xong)
- Mới `tests/integration/gherkin.test.ts` (theo mẫu schedule-notify.test.ts):
  parse endpoint qua `app.inject` (không browser): login flow VI →
  đủ steps + unparsed rỗng; text rác → unparsed显式; projectId của project
  khác → 403; CRUD vòng đời không đụng (endpoint stateless).
- Sửa `docs/github-ideas.md`: mục 3 đánh dấu DONE + ngày.
- Verify: file test mới pass + `pnpm test:integration:p1` xanh (hoặc ít nhất
  file mới + rbac + schedule-notify không regression).

## 4. Quy tắc chung cho cả 4 agent
- Windows, shell PowerShell 5.1. Không commit/push (chủ session làm).
- Không sửa file ngoài danh sách của mình. Không đổi hành vi hiện có
  (P0 byte-identical: `nlToSteps` cũ phải pass test cũ nguyên).
- Secret: không inline, không log value. Fill sensitive giữ nguyên
  `sensitive: true` từ matcher.
- Xong việc: liệt kê file đã đụng + lệnh verify đã chạy + kết quả.
