# Ý tưởng từ GitHub (đã khảo sát, chưa làm)

Ngày ghi: 2026-10-05. Nguồn: hal-test, playwright-testgen, waterfall-ai-test-platform,
AutonomateQA, playwright-automation-framework (yousufwaqar), autoframe, BestTester,
specter, Cortex-SDET, zero-cost-self-healing-qa, E2E-Self-Heal, cbrowser, specwright.

## 1. Bug-from-failure 1-click (ưu tiên cao nhất)
- Nút biến run đỏ thành ticket bug hoàn chỉnh: steps lỗi + screenshot + trace + error gọn.
- Đẩy sang Jira/Redmine/email qua template + webhook.
- Tham khảo: autoframe `/bug-from-failure`, Cortex-SDET HTML report.
- Ước lượng: ~1 ngày.

## 2. Healing deterministic không-LLM (nâng cấp P2)
- Khi primary fail: chấm điểm DOM live (text 0.45 + context 0.2 + tag/attrs/class/id) tìm element giống nhất rồi mới đề xuất.
- Không tốn tiền LLM, deterministic, auditable — đúng triết lý P0 (không tự áp dụng).
- Tham khảo: ShantanuVr/playwright-self-healing-framework (6-signal scoring),
  Renjithnj/zero-cost-self-healing-qa (10-tier cache), specter (SQLite selector memory).
- Ước lượng: ~2–3 ngày.

## 3. Gherkin tiếng Việt (killer feature local)
- View BDD: tester viết `Cho rằng/Khi/Thì` → map sang steps JSON có sẵn.
- Tham khảo: AutonomateQA (Gherkin + AI), specwright (BDD pipeline).
- Ước lượng: ~2 ngày.

## Để sau
- Composite quality-gate: gom a11y/visual/security thành 1 bảng đạt/không (tham khảo yousufwaqar).
- MCP server để AI agent gọi Studio (tham khảo @playwright/mcp, BestTester).
- Docker Compose đóng gói (tham khảo hal-test, BestTester).
- Windows-Service doc cho startup script (AutonomateQA có docs/Windows-Service.md mẫu).
- k6 load testing: ngoài phạm vi hiện tại.
