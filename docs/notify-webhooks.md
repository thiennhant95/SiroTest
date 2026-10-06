# Schedule failure alerts + run-event webhooks (operator note)

## 1. Enabling Slack / Lark integrations

Per project: **Settings → Integrations** → provider **Slack** or **Lark**.

| Provider | Config field | Value |
|---|---|---|
| Slack | `webhookUrl` | Incoming webhook URL |
| Lark | `webhookUrl` | Custom bot webhook URL |

Keep the integration **enabled** (list shows an enable/disable toggle).
Secrets are encrypted at rest and never returned by read APIs — never paste
tokens or URLs into tickets, logs, or chat.

## 2. Per-schedule notify toggle

New/edit schedule dialog → tick **Notify on failure** (`notifyOnFailure`).
Only **failed** scheduled runs notify; passing and cancelled runs stay silent.
The schedule row shows a **notify on failure** badge and `last <status>`
(`last run failed` on red).

If no Slack/Lark integration is enabled, the failure is logged server-side
and nobody is pinged — the toggle alone is not enough.

## 3. Generic webhook (run events)

Provider **Webhook (run events)**: `url` + optional `signingSecret`.
Only **enabled** webhooks receive deliveries, one per terminal outcome:

| Header | Value |
|---|---|
| `X-VV-Event` | `run.passed` / `run.failed` / `run.cancelled` |
| `X-VV-Signature` | `v1=<hex>` HMAC-SHA256 of the raw JSON body (only when `signingSecret` is set) |

Verify against the **raw request bytes** before JSON parsing, with a
constant-time compare. Reject missing/mismatched signatures (e.g. HTTP 401):

```js
import { createHmac, timingSafeEqual } from "node:crypto";

function verifyRunEvent(rawBody, req) {
  const secret = process.env.VV_WEBHOOK_SECRET; // the signingSecret you configured
  const got = req.headers["x-vv-signature"] ?? "";
  const event = req.headers["x-vv-event"] ?? "";
  if (!secret || !got) return false;
  const expected = "v1=" + createHmac("sha256", secret).update(rawBody).digest("hex");
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(got, "utf8");
  return a.length === b.length && timingSafeEqual(a, b) && event.startsWith("run.");
}
```

## 4. Delivery semantics

Best-effort, no retries: delivery failures are logged server-side and never
fail or delay the run. A schedule that stays red notifies again on the next
firing. Design receivers idempotent (key on run id + event).

## 5. Audit actions to watch

- `schedule.notify-failure` — a failure alert was attempted for a schedule.
- Run-now, healing approve/reject, and delete deliveries are audit-logged too.

Check the project's **Audit** page after wiring alerts: trigger a failing
scheduled run (or Run now), confirm the message arrives, then confirm the
audit row exists.
