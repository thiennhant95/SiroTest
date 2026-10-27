# Truy cập từ xa cho BRSE qua Tailscale (tạm thời)

> Đối tượng: IT + team lead. Tester/BRSE chỉ cần đọc mục 5.
> Nguyên tắc: **máy chủ ở văn phòng, BRSE ở đâu cũng vào được bằng danh tính thật.**
> Trạng thái: giải pháp tạm — khi BRSE > 30 người hoặc có audit bảo mật, chuyển sang
> Cloudflare Access + SSO (xem cuối file).

## 0. Kiến trúc (đọc 1 phút)

```
BRSE ở nhà/khách hàng/café (Windows, có internet)
   │  Tailscale (mạng riêng ảo, không mở port router)
   ▼
Máy chủ văn phòng (Windows, mạng dây, không tắt)
   ├─ Web UI  : http://100.x.y.z:5173  (BRSE mở bằng Chrome/Edge)
   └─ API     : http://127.0.0.1:3001  (chỉ máy chủ thấy, web proxy qua)
```

- BRSE **không cài** Node/pnpm/browser-test. Chỉ cần browser + link.
- Mọi thao tác của BRSE đều ghi audit (`Audit` trong tool) như người ngồi văn phòng.
- File vận hành: `start-tool.ps1` (chạy cả server+web), `scripts/add-member.mjs` (cấp quyền tạm).

## 1. Chuẩn bị

| Thứ | Yêu cầu | Lấy ở đâu |
|---|---|---|
| Máy chủ | Windows 10/11, RAM ≥ 8GB, **mạng dây**, không sleep/hibernate | IT chuẩn bị |
| Tài khoản team | Google/Microsoft chung công ty (đăng nhập Tailscale) | Admin Google/MS |
| Quyền Tailscale admin | duyệt máy vào mạng | người giữ admin |
| `SECRET_ENCRYPTION_KEY` | base64 32 bytes (giải mã secret trong DB) | team lead |
| `VV_AI_API_KEY` | key gateway AI (tính năng Explain/Compose) | team lead |
| IP tailnet máy chủ | dạng `100.x.y.z` | xem ở mục 2 bước 3 |

Không có key AI thì tool vẫn chạy (AI về chế độ rules) — 2 key trên thiếu cái nào thì báo, đừng bịa.

## 2. Lắp Tailscale (mỗi máy 3 phút)

**Bước 1 — Cài.** Mở `https://tailscale.com/download` → Windows → cài đặt →
biểu tượng Tailscale hiện ở khay hệ thống (góc phải taskbar) → bấm **Log in** →
đăng nhập bằng tài khoản công ty. Làm cho máy chủ + từng máy BRSE.

**Bước 2 — Duyệt.** Admin mở `https://login.tailscale.dev` → **Machines** →
máy mới hiện nút **Approve** thì bấm. (Nếu không thấy nút, nghĩa là admin đã bật
auto-approve — bỏ qua.)

**Bước 3 — Lấy IP.** Di chuột lên icon Tailscale ở **máy chủ**, ghi dãy số
`100.x.y.z` (ví dụ `100.87.41.12`). Đây là "địa chỉ văn phòng" của BRSE.

**Kiểm tra nhanh:** từ máy BRSE mở `http://100.x.y.z:5173` — chưa thấy tool cũng
được (mục 3 chưa chạy), nhưng không được báo DNS/timeout. Timeout = hầm chưa
thông → xem Troubleshooting #1.

## 3. Chạy tool chế độ public (máy chủ, 5 phút)

**Bước 4 — Nạp key 1 lần duy nhất.** Mở PowerShell trên máy chủ, paste 2 dòng
(đóng PowerShell đi là xong, key lưu theo máy — **không paste key vào chat/file**):

```powershell
setx SECRET_ENCRYPTION_KEY "<dán key team lead đưa>"
setx VV_AI_API_KEY "<dán key team lead đưa>"
```

**Bước 5 — Chạy.** Mở PowerShell tại thư mục tool:

```powershell
powershell -ExecutionPolicy Bypass -File start-tool.ps1 -Public
```

Đợi dòng kết quả (khoảng 15–30 giây):

```
server PID=... 3001=True | web PID=... 5173=True | mode=PUBLIC (no Dev auth)
```

Ý nghĩa từng chữ:
- `3001=True 5173=True` — cả API lẫn web đã nghe. `False` = port kẹt tiến trình
  cũ → script đã tự kill rồi chạy lại bước 5.
- `PUBLIC (no Dev auth)` — **không còn tab Dev bypass**. Bỏ `-Public` là chế độ
  local (có Dev, web chỉ nghe localhost) — dùng khi tester ngồi tại máy chủ.

> Vì sao không chạy `npx vite` tay: thiếu `--host 0.0.0.0` thì web chỉ nghe
> localhost, BRSE ngoài mạng không bao giờ tới được. Script `-Public` lo sẵn.

**Đọc log khi sự cố:** `%TEMP%\opencode\vv-server.log` và `vv-web.log`
(`Win+R → %TEMP%\opencode`).

**Tự chạy khi mở máy (khuyến nghị):** Task Scheduler → Create Task →
Trigger *At log on* → Action chạy `powershell.exe` với argument
`-ExecutionPolicy Bypass -File "D:\...\start-tool.ps1 -Public"` (điền đường dẫn
thật). Kẻo thứ 2 cả team gọi vì quên bật tool.

## 4. Tài khoản + phân quyền

**Bước 6 — BRSE đăng ký.** BRSE mở `http://100.x.y.z:5173` → trang Login →
tab **Sign up** → email + mật khẩu → vào được nhưng **chưa thấy project nào**.
Đây là bình thường (tool chưa có nút mời member — xem chú thích ở bước 7).

**Bước 7 — IT cấp quyền (tạm thời bằng script).** PowerShell tại thư mục tool:

```powershell
$env:DATABASE_URL='file:D:/VietVang/Project/playwright-vv/apps/server/pilot-mizoguchi.db'
node scripts/add-member.mjs brse@congty.com editor
```

- `editor` = viết + chạy test (cho BRSE). Người chỉ xem: ghi `viewer`.
- Thêm project khác: gắn thêm id project cuối lệnh (mặc định là Demo Print).
- Thành công in: `OK brse@congty.com -> Demo Print as editor`.
- Lỗi `no User row` = người đó chưa Sign up (quay lại bước 6).
- Không bao giờ cấp `owner` bằng script.

| Role | Được | Không được |
|---|---|---|
| viewer | Đọc mọi thứ, chạy test, xem video/trace | Tạo/sửa/xóa |
| editor | Mọi thứ của viewer + tạo/sửa/chạy/dọn | Xóa project |
| owner | Tất cả (chỉ người tạo project) | — |

> `scripts/add-member.mjs` là băng dính tạm: ghi thẳng DB, không sinh audit row
> (giống `cleanup-db.mjs`). Khi tool có nút mời member trong Settings thì xóa
> file này. Việc đáng làm nửa ngày, đã ghi nợ.

**Bước 8 — BRSE đăng nhập lại** (F5) → thấy project Demo Print → mở 1 test bấm
Run thử → xanh là xong onboarding.

## 5. Dành cho BRSE (đọc tới đây là đủ)

1. Mở `http://100.x.y.z:5173` (lấy IP ở IT, bookmark lại).
2. Login tài khoản của bạn. Không có tab Dev — là đúng (chế độ public).
3. Làm test như bình thường (xem Cẩm nang Tester). Mạng chậm thì video/trace
   vẫn xem được — đợi load, đừng bấm Run liên tục (mỗi Run chiếm 1 worker).
4. Hết việc: cứ tắt browser. Không cần logout, không cần tắt gì thêm.

## 6. Nghiệm thu (từ 4G, 5 phút)

**Bước 9 — Test 4G.** Tắt wifi điện thoại, bật 4G → mở IP tailnet (dùng browser
điện thoại) → login → mở 1 run cũ xem được video → **đạt**.

**Bước 10 — Ghi sheet IT:**

| IP tailnet máy chủ | Email BRSE | Quyền | Ngày cấp | Người cấp |
|---|---|---|---|---|
| 100.87.41.12 | brse@congty.com | editor | 2026-… | … |

## 7. Bảo mật (3 cấm kỵ)

1. **Cấm Dev mode ra ngoài.** `-Public` tắt `ALLOW_DEV_AUTH`. Nếu thấy tab Dev
   khi truy cập từ ngoài = đang chạy sai chế độ → chạy lại bước 5.
2. **Cấm http công cộng.** Chỉ đi qua Tailscale (mã hóa sẵn). Không NAT port
   5173/3001 ra internet bao giờ.
3. **Key lộ thì regen.** Key AI/Backlog từng paste ở chat → nếu chat share ra
   ngoài, regen key mới, `setx` lại (bước 4), báo team cập nhật. Secret trong DB
   mã hóa AES-256-GCM, API không bao giờ trả plaintext — giữ nguyên, đừng tắt.

## 8. Vận hành hàng ngày

- **Restart tool:** chạy lại bước 5 (script tự kill tiến trình cũ).
- **Backup:** copy file `apps\server\pilot-mizoguchi.db` sang chỗ khác mỗi tuần
  (SQLite = 1 file, copy là xong) + thư mục artifacts nếu cần video cũ.
- **Update bản mới:** `git pull` → chạy lại bước 5. Test/lịch sử run/variables
  nằm trong DB nên còn nguyên.
- **Xem ai làm gì:** mở `Audit` trong tool (kể cả BRSE ngoài mạng).

## 9. Troubleshooting

| # | Triệu chứng | Nguyên nhân hay gặp | Sửa |
|---|---|---|---|
| 1 | BRSE mở IP không được (timeout) | Tailscale chưa login/approve; nhầm IP; máy chủ tắt | Kiểm tra icon Tailscale 2 đầu, Approve ở admin, ping IP tailnet |
| 2 | Thấy trang login nhưng không có tab Dev | Đúng (chế độ public) — BRSE dùng Sign up | Không phải lỗi |
| 3 | Login báo 403/no access sau Sign up | Chưa chạy bước 7 | `add-member.mjs` cho đúng email |
| 4 | Run treo ở `queued` mãi | Hết worker (tối đa 2) hoặc run cũ kẹt | Đợi / Cancel run cũ; xem `%TEMP%\opencode\vv-server.log` |
| 5 | Video/trace không load từ xa | Mạng yếu + file lớn | Đợi; thử Download thay vì xem inline |
| 6 | Login chập chờn sau nhiều lần thử | Rate-limit / gõ sai | Nghỉ 1–2 phút, kiểm tra lại mật khẩu |
| 7 | Sáng thứ 2 không vào được | Máy chủ tắt/ngủ đêm | Bật máy, chạy bước 5; ghim Task Scheduler |
| 8 | Tailscale báo key/device expired | Lâu không mở máy | Mở app Tailscale Log in lại |
| 9 | Đổi mật khẩu AI/secret | Key cũ hết hạn | `setx` lại (bước 4) + chạy lại bước 5 |
| 10 | Muốn thu quyền ai đó | Nghỉ việc/đổi team | Chạy `add-member.mjs <email> viewer` (không có lệnh xóa nhanh — ghi nợ cùng nút mời member) |

## 10. Khi nào bỏ Tailscale

- BRSE > 30 người, hoặc khách hàng/pass audit bảo mật hỏi tới → chuyển
  Cloudflare Tunnel + Access (SSO Google/MS công ty) — tool không đổi gì,
  chỉ thay đường vào.
- Giữ file này cập nhật theo: mỗi lần đổi cách vào, sửa mục 2 + 9.
