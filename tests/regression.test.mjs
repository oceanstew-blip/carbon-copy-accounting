// Regression suite per Carbon Copy Accounting stabilization brief, Priority 2.
// Boots the real app in-process against a throwaway Postgres and exercises it over HTTP.
// Run with: npm test (tests/run.sh manages the Docker Postgres container and calls this).
//
// ponytail: this file assumes DATABASE_URL/PORT/etc are already set and the DB is
// already reachable (tests/run.sh does that). Also: retry waits use a plain
// for-loop, not a recursive setTimeout/async-IIFE "tick" pattern — that pattern
// deterministically hangs every subsequent fetch() in this process on this
// machine (confirmed by bisection; unrelated to Docker or timing). Never
// root-caused past "don't do that."
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import crypto from "node:crypto";

const APP_PORT = Number(process.env.PORT || 8321);
const BASE = `http://127.0.0.1:${APP_PORT}`;
const AUTH = "Basic " + Buffer.from("test:test").toString("base64");
let pool, init;

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

function apiFetch(path, opts = {}) {
  return fetch(BASE + path, {
    ...opts,
    headers: { Authorization: AUTH, "Content-Type": "application/json", ...(opts.headers || {}) },
  });
}

async function waitFor(fn, timeoutMs = 20000, intervalMs = 300) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try { if (await fn()) return; } catch {}
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error("timed out waiting");
}

async function setup() {
  process.env.APP_USERNAME = "test";
  process.env.APP_PASSWORD = "test";
  ({ pool, init } = await import("../server.js"));

  await waitFor(async () => {
    try { return (await apiFetch("/health")).ok; } catch { return false; }
  }, 10000);
}

async function teardown() {
  try { await pool?.end(); } catch {}
}

// ---- Application ----

test("server.js has valid syntax", () => {
  execSync("node --check server.js");
});

test("/health responds ok", async () => {
  const res = await apiFetch("/health");
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
});

test("/api/bootstrap works and app has reference data", async () => {
  const res = await apiFetch("/api/bootstrap");
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(body.categories.length > 0, "categories should be seeded");
  assert.ok(body.cards.length > 0, "cards should be seeded");
});

test("app root loads (auth-gated)", async () => {
  const noAuth = await fetch(BASE + "/");
  assert.equal(noAuth.status, 401, "unauthenticated request must be rejected");
  const authed = await apiFetch("/");
  assert.equal(authed.status, 200);
});

// ---- Startup must not mutate accounting data (Priority 1 regression guard) ----

test("re-running init() (what every startup does) does not change transaction count", async () => {
  const before = await (await apiFetch("/api/transactions?month=2026-09")).json();
  await init();
  await init();
  const after = await (await apiFetch("/api/transactions?month=2026-09")).json();
  assert.equal(after.rows.length, before.rows.length, "repeated init() must not create/remove transactions");
});

// ---- Cash / Check / Wire ----

test("cash receipt transaction posts immediately, never pending", async () => {
  const ext = "test-cash-" + crypto.randomUUID();
  const res = await apiFetch("/api/transactions", {
    method: "POST",
    body: JSON.stringify({
      transaction_date: "2026-09-10", vendor_raw: "Dock Hand Tip", amount: 40,
      payment_method: "cash", external_id: ext,
    }),
  });
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.equal(body.inserted, 1);
  const list = await (await apiFetch("/api/transactions?month=2026-09")).json();
  const row = list.rows.find((r) => r.vendor_raw === "Dock Hand Tip");
  assert.ok(row, "cash transaction should appear immediately");
  assert.equal(row.status, "posted", "cash must never sit unposted / waiting to match");
  assert.equal(row.payment_method, "cash");
});

// ---- Import / dedupe ----

test("card number 945 normalizes to 0945", async () => {
  const ext = "test-card-norm-" + crypto.randomUUID();
  await apiFetch("/api/transactions", {
    method: "POST",
    body: JSON.stringify({
      transaction_date: "2026-09-11", vendor_raw: "WAWA 5194", amount: 55.5,
      card_last4: "945", external_id: ext,
    }),
  });
  const list = await (await apiFetch("/api/transactions?month=2026-09")).json();
  const row = list.rows.find((r) => r.vendor_raw === "WAWA 5194" && r.last4);
  assert.equal(row?.last4, "0945");
});

test("duplicate external_id import is safe (no duplicate insert)", async () => {
  const ext = "test-dup-" + crypto.randomUUID();
  const payload = { transaction_date: "2026-09-12", vendor_raw: "DUPLICATE TEST VENDOR", amount: 12.34, external_id: ext };
  const first = await (await apiFetch("/api/transactions", { method: "POST", body: JSON.stringify(payload) })).json();
  const second = await (await apiFetch("/api/transactions", { method: "POST", body: JSON.stringify(payload) })).json();
  assert.equal(first.inserted, 1);
  assert.equal(second.inserted, 0);
  assert.equal(second.skipped, 1);
});

test("legitimate repeated identical-looking charges are not silently discarded (different external_id)", async () => {
  const base = { transaction_date: "2026-09-13", vendor_raw: "Boca Resort Cafe", amount: 6 };
  const a = await (await apiFetch("/api/transactions", { method: "POST", body: JSON.stringify({ ...base, external_id: "rep-a-" + crypto.randomUUID() }) })).json();
  const b = await (await apiFetch("/api/transactions", { method: "POST", body: JSON.stringify({ ...base, external_id: "rep-b-" + crypto.randomUUID() }) })).json();
  assert.equal(a.inserted, 1);
  assert.equal(b.inserted, 1, "two distinct $6 charges same vendor/day must both post");
});

// ---- Categories ----

// Vendor rules are no longer auto-seeded on boot (Priority 1 fix), so these
// tests create their own rule first — that's what production already has from
// before this fix; here we're testing the matching logic, not the seed data.
test("meals classify to Provisions via vendor rule", async () => {
  const boot = await (await apiFetch("/api/bootstrap")).json();
  const provisions = boot.categories.find((c) => c.name === "Provisions");
  await apiFetch("/api/vendor-rules", { method: "POST", body: JSON.stringify({ vendor_pattern: "BOCARESORTCAFE", category_id: provisions.id }) });
  const ext = "test-meal-" + crypto.randomUUID();
  await apiFetch("/api/transactions", {
    method: "POST",
    body: JSON.stringify({ transaction_date: "2026-09-14", vendor_raw: "BOCARESORTCAFE TESTRUN", amount: 6, external_id: ext }),
  });
  const list = await (await apiFetch("/api/transactions?month=2026-09")).json();
  const row = list.rows.find((r) => r.vendor_raw === "BOCARESORTCAFE TESTRUN");
  assert.equal(row?.category_name, "Provisions");
});

test("weather/routing vendors classify to Navigation / Weather", async () => {
  const boot = await (await apiFetch("/api/bootstrap")).json();
  const navWeather = boot.categories.find((c) => c.name === "Navigation / Weather");
  await apiFetch("/api/vendor-rules", { method: "POST", body: JSON.stringify({ vendor_pattern: "BUOYWEATHER", category_id: navWeather.id }) });
  const ext = "test-weather-" + crypto.randomUUID();
  await apiFetch("/api/transactions", {
    method: "POST",
    body: JSON.stringify({ transaction_date: "2026-09-15", vendor_raw: "BUOYWEATHER PREMIUM TEST", amount: 16.28, external_id: ext }),
  });
  const list = await (await apiFetch("/api/transactions?month=2026-09")).json();
  const row = list.rows.find((r) => r.vendor_raw === "BUOYWEATHER PREMIUM TEST");
  assert.equal(row?.category_name, "Navigation / Weather");
});

test("add category", async () => {
  const res = await apiFetch("/api/categories", { method: "POST", body: JSON.stringify({ name: "Regression Test Category" }) });
  assert.equal(res.status, 201);
});

test("rename category", async () => {
  const created = await (await apiFetch("/api/categories", { method: "POST", body: JSON.stringify({ name: "Rename Me" }) })).json();
  const res = await apiFetch(`/api/categories/${created.id}`, { method: "PATCH", body: JSON.stringify({ name: "Renamed" }) });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).name, "Renamed");
});

test("delete unused category succeeds directly", async () => {
  const created = await (await apiFetch("/api/categories", { method: "POST", body: JSON.stringify({ name: "Unused Category" }) })).json();
  const res = await apiFetch(`/api/categories/${created.id}`, { method: "DELETE" });
  assert.equal(res.status, 200);
});

test("deleting a used category without replacement is blocked", async () => {
  const cat = await (await apiFetch("/api/categories", { method: "POST", body: JSON.stringify({ name: "In Use Category" }) })).json();
  await apiFetch("/api/transactions", {
    method: "POST",
    body: JSON.stringify({ transaction_date: "2026-09-16", vendor_raw: "In Use Vendor", amount: 5, external_id: "test-inuse-" + crypto.randomUUID() }),
  });
  const list = await (await apiFetch("/api/transactions?month=2026-09")).json();
  const tx = list.rows.find((r) => r.vendor_raw === "In Use Vendor");
  await apiFetch(`/api/transactions/${tx.id}`, { method: "PATCH", body: JSON.stringify({ category_id: cat.id }) });
  const res = await apiFetch(`/api/categories/${cat.id}`, { method: "DELETE" });
  assert.equal(res.status, 409, "must refuse to delete a category still in use");
});

test("deleting a used category with a replacement reassigns transactions", async () => {
  const from = await (await apiFetch("/api/categories", { method: "POST", body: JSON.stringify({ name: "From Category" }) })).json();
  const to = await (await apiFetch("/api/categories", { method: "POST", body: JSON.stringify({ name: "To Category" }) })).json();
  await apiFetch("/api/transactions", {
    method: "POST",
    body: JSON.stringify({ transaction_date: "2026-09-17", vendor_raw: "Reassign Vendor", amount: 5, external_id: "test-reassign-" + crypto.randomUUID() }),
  });
  const list = await (await apiFetch("/api/transactions?month=2026-09")).json();
  const tx = list.rows.find((r) => r.vendor_raw === "Reassign Vendor");
  await apiFetch(`/api/transactions/${tx.id}`, { method: "PATCH", body: JSON.stringify({ category_id: from.id }) });
  const res = await apiFetch(`/api/categories/${from.id}`, { method: "DELETE", body: JSON.stringify({ replacement_category_id: to.id }) });
  assert.equal(res.status, 200);
  const after = await (await apiFetch("/api/transactions?month=2026-09")).json();
  assert.equal(after.rows.find((r) => r.id === tx.id).category_name, "To Category");
});

test("vendor rules still render after category editing", async () => {
  const cat = await (await apiFetch("/api/categories", { method: "POST", body: JSON.stringify({ name: "Vendor Rule Category" }) })).json();
  await apiFetch(`/api/categories/${cat.id}`, { method: "PATCH", body: JSON.stringify({ name: "Vendor Rule Category Renamed" }) });
  await apiFetch("/api/vendor-rules", { method: "POST", body: JSON.stringify({ vendor_pattern: "REGRESSION TEST VENDOR RULE", category_id: cat.id }) });
  const boot = await (await apiFetch("/api/bootstrap")).json();
  const rule = boot.rules.find((r) => r.vendor_pattern === "REGRESSION TEST VENDOR RULE");
  assert.ok(rule, "vendor rule should still be listed");
  assert.equal(rule.category_name, "Vendor Rule Category Renamed");
});

// ---- Month close ----

test("month close is blocked when there are uncategorized transactions", async () => {
  await apiFetch("/api/transactions", {
    method: "POST",
    body: JSON.stringify({ transaction_date: "2026-08-01", vendor_raw: "Uncategorized August Vendor", amount: 5, external_id: "test-augblock-" + crypto.randomUUID() }),
  });
  const res = await apiFetch("/api/close-month", { method: "POST", body: JSON.stringify({ month: "2026-08" }) });
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.equal(body.closed, false);
  assert.ok(body.blockers.uncategorized > 0);
});

// ---- Runner ----

async function run() {
  await setup();
  let pass = 0, fail = 0;
  for (const { name, fn } of tests) {
    try {
      await fn();
      console.log(`✓ ${name}`);
      pass++;
    } catch (e) {
      console.log(`✗ ${name}`);
      console.log(`  ${e.message}`);
      fail++;
    }
  }
  await teardown();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

run().catch((e) => {
  console.error("SETUP FAILED", e);
  teardown().finally(() => process.exit(1));
});
