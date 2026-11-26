import { chromium } from "@playwright/test";
const API = "http://127.0.0.1:3001/api/v1";
const WEB = "http://127.0.0.1:5173";
const H = { Authorization: "Bearer tester-1", "Content-Type": "application/json" };
const j = async (r) => { const t = await r.text(); try { return JSON.parse(t); } catch { throw new Error(r.status + " " + t.slice(0, 200)); } };

const projects = await j(await fetch(`${API}/projects`, { headers: H }));
const project = projects.find((p) => p.name === "Demo Print");
const test = await j(await fetch(`${API}/projects/${project.id}/tests`, { method: "POST", headers: H, body: JSON.stringify({ name: `live-view-${Date.now()}`, browser: "chromium" }) }));

const browser = await chromium.launch({ headless: true });
const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
const errors = [];
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text().slice(0, 160)); });
await page.goto(WEB, { waitUntil: "domcontentloaded" });
await page.evaluate(() => localStorage.setItem("vv_token", "tester-1"));

await page.goto(`${WEB}/tests/${test.id}/record`, { waitUntil: "networkidle" });
await page.getByRole("textbox").first().fill("http://127.0.0.1:3123/fixture/login");
await page.getByRole("button", { name: /start/i }).first().click();

const img = page.locator('img[alt="Live browser"]');
let gotFrame = false;
try {
  await img.waitFor({ state: "visible", timeout: 20000 });
  await page.waitForFunction(() => {
    const el = document.querySelector('img[alt="Live browser"]');
    return !!el && el.getAttribute("src")?.startsWith("data:image/jpeg");
  }, null, { timeout: 25000 });
  gotFrame = true;
} catch { /* reported below */ }
console.log("frame=" + gotFrame);

if (gotFrame) {
  const box = await img.boundingBox();
  if (box) {
    await img.click({ position: { x: box.width * 0.5, y: box.height * 0.35 } });
    await page.waitForTimeout(600);
    await img.click({ position: { x: box.width * 0.5, y: box.height * 0.42 } });
    await page.keyboard.type("qa@acme.test", { delay: 20 });
    await page.waitForTimeout(800);
  }
}

// session steps after input
const sessions = await j(await fetch(`${API}/tests/${test.id}/recorder/sessions`, { headers: H })).catch(() => []);
console.log("sessions-api=" + JSON.stringify(sessions).slice(0, 120));

const stop = page.getByRole("button", { name: /stop/i }).first();
if (await stop.count()) { await stop.click(); await page.waitForTimeout(1200); }
console.log("console-errors=" + JSON.stringify(errors.slice(0, 3)));
await page.screenshot({ path: "C:/Users/ASUS/AppData/Local/Temp/opencode/live-view.png", fullPage: false });
await browser.close();

// cleanup
await fetch(`${API}/tests/${test.id}`, { method: "DELETE", headers: H }).catch(() => {});
console.log("DONE");
