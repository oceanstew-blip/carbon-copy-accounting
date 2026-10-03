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
import { parseOcrReceipt, isoReceiptDate, detectPaymentMethodFromText } from "../ocr.js";
import ExcelJS from "exceljs";

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

test("legitimate repeated identical-looking charges are not silently discarded (no external_id — ambiguous fingerprint)", async () => {
  // No external_id supplied on either row: same vendor/amount/day, indistinguishable
  // from a true duplicate. Priority 3 requires both to post, second one flagged.
  const base = { transaction_date: "2026-09-13", vendor_raw: "Boca Resort Cafe Regression " + crypto.randomUUID(), amount: 6 };
  const res = await apiFetch("/api/transactions", { method: "POST", body: JSON.stringify({ rows: [base, base] }) });
  const body = await res.json();
  assert.equal(body.inserted, 2, "two distinct $6 charges same vendor/day must both post, not collapse to one");
  assert.equal(body.suspected_duplicates, 1, "the second one must be flagged, not silently dropped");
  const list = await (await apiFetch(`/api/transactions?month=2026-09`)).json();
  const rows = list.rows.filter((r) => r.vendor_raw === base.vendor_raw);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.duplicate_status).sort(), ["none", "suspected"]);
});

test("high-frequency vendors (Amazon, Publix) are exempt from the suspected-duplicate flag", async () => {
  const base = { transaction_date: "2026-09-14", vendor_raw: "AMAZON MKTPL*" + crypto.randomUUID().slice(0, 8), amount: 24.99 };
  const res = await apiFetch("/api/transactions", { method: "POST", body: JSON.stringify({ rows: [base, base] }) });
  const body = await res.json();
  assert.equal(body.inserted, 2);
  assert.equal(body.suspected_duplicates, 0, "two same-day, same-amount Amazon charges are normal, not suspicious");
  const list = await (await apiFetch(`/api/transactions?month=2026-09`)).json();
  const rows = list.rows.filter((r) => r.vendor_raw === base.vendor_raw);
  assert.deepEqual(rows.map((r) => r.duplicate_status), ["none", "none"]);
});

test("uploading the same statement file twice is a safe no-op", async () => {
  const hash = "test-file-hash-" + crypto.randomUUID();
  const payload = { file_hash: hash, source_filename: "test.csv", rows: [
    { transaction_date: "2026-07-01", vendor_raw: "Batch Vendor " + crypto.randomUUID(), amount: 10 },
  ] };
  const first = await (await apiFetch("/api/transactions", { method: "POST", body: JSON.stringify(payload) })).json();
  const second = await (await apiFetch("/api/transactions", { method: "POST", body: JSON.stringify(payload) })).json();
  assert.equal(first.inserted, 1);
  assert.equal(second.duplicate_import, true);
  assert.equal(second.inserted, 0);
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

// ---- Receipt matching (Priority 4) ----

async function insertBareReceipt({ vendor, amount, receipt_date, payment_method = "credit_card" }) {
  const q = await pool.query(
    `INSERT INTO receipts(file_name,content_type,file_size,file_data,receipt_date,vendor,amount,payment_method,review_required)
     VALUES($1,'image/png',0,NULL,$2,$3,$4,$5,true) RETURNING id`,
    [`test-${crypto.randomUUID()}.png`, receipt_date, vendor, amount, payment_method]
  );
  return q.rows[0].id;
}

test("strong match (same-day + vendor text match) auto-links on next transaction insert", async () => {
  const vendorTag = "MatchTestMarine" + crypto.randomUUID().slice(0, 8);
  const receiptId = await insertBareReceipt({ vendor: vendorTag, amount: 42.5, receipt_date: "2026-09-20" });
  await apiFetch("/api/transactions", {
    method: "POST",
    body: JSON.stringify({ transaction_date: "2026-09-20", vendor_raw: vendorTag + " SUPPLY CO", amount: 42.5, external_id: "test-match-" + crypto.randomUUID() }),
  });
  const check = await (await apiFetch(`/api/receipts/${receiptId}/candidates`)).json();
  assert.equal(check.already_matched, true, "receipt should have auto-linked");
});

test("unmatched card receipt shows as pending in Transactions, then disappears once its charge arrives; never counted as posted", async () => {
  const tag = "PendingTestMarine" + crypto.randomUUID().slice(0, 8);
  const receiptId = await insertBareReceipt({ vendor: tag, amount: 61.25, receipt_date: "2026-09-21" });
  const noDate = await insertBareReceipt({ vendor: "NoDate" + tag, amount: 9, receipt_date: null });
  const cash = await insertBareReceipt({ vendor: "Cash" + tag, amount: 5, receipt_date: "2026-09-21", payment_method: "cash" });
  let list = await (await apiFetch("/api/transactions?month=2026-09")).json();
  assert.ok(list.pending.some((p) => p.receipt_id === receiptId && p.vendor_raw === tag), "card receipt with date+amount should be pending");
  assert.ok(!list.pending.some((p) => p.receipt_id === noDate), "receipt with no date stays in review, not pending");
  assert.ok(!list.pending.some((p) => p.receipt_id === cash), "cash receipts are never pending");
  assert.ok(!list.rows.some((r) => r.vendor_raw === tag), "pending receipt must not appear among posted transactions");
  await apiFetch("/api/transactions", {
    method: "POST",
    body: JSON.stringify({ transaction_date: "2026-09-21", vendor_raw: tag + " SUPPLY CO", amount: 61.25, external_id: "test-pending-" + crypto.randomUUID() }),
  });
  list = await (await apiFetch("/api/transactions?month=2026-09")).json();
  assert.ok(!list.pending.some((p) => p.receipt_id === receiptId), "once matched, the receipt is no longer pending");
});

test("receipt inbox: only confirmed, readable card receipts count as waiting; unconfirmed ones need review", async () => {
  const tag = "BucketTest" + crypto.randomUUID().slice(0, 8);
  const unconfirmed = await insertBareReceipt({ vendor: tag, amount: 11, receipt_date: "2026-08-02" });
  const confirmed = await insertBareReceipt({ vendor: tag + "ok", amount: 12, receipt_date: "2026-08-02" });
  await pool.query("UPDATE receipts SET review_required=false WHERE id=$1", [confirmed]);
  const inbox = await (await apiFetch("/api/receipt-inbox")).json();
  assert.equal(inbox.rows.find((r) => r.id === unconfirmed)?.bucket, "review");
  assert.equal(inbox.rows.find((r) => r.id === confirmed)?.bucket, "waiting");
});

test("ambiguous match (no vendor signal, tied candidates) does not auto-link", async () => {
  const tag = crypto.randomUUID().slice(0, 8);
  const receiptId = await insertBareReceipt({ vendor: null, amount: 17.77, receipt_date: "2026-09-21" });
  await apiFetch("/api/transactions", {
    method: "POST",
    body: JSON.stringify({ rows: [
      { transaction_date: "2026-09-21", vendor_raw: "Ambiguous Vendor A " + tag, amount: 17.77, external_id: "amb-a-" + crypto.randomUUID() },
      { transaction_date: "2026-09-21", vendor_raw: "Ambiguous Vendor B " + tag, amount: 17.77, external_id: "amb-b-" + crypto.randomUUID() },
    ] }),
  });
  const check = await (await apiFetch(`/api/receipts/${receiptId}/candidates`)).json();
  assert.equal(check.already_matched, undefined, "must not have guessed between two equally plausible candidates");
  assert.ok(check.candidates.length >= 2, "both candidates should be surfaced for the captain to choose from");
});

test("captain can manually resolve an ambiguous match", async () => {
  const tag = crypto.randomUUID().slice(0, 8);
  const receiptId = await insertBareReceipt({ vendor: null, amount: 88.5, receipt_date: "2026-09-22" });
  await apiFetch("/api/transactions", {
    method: "POST",
    body: JSON.stringify({ transaction_date: "2026-09-22", vendor_raw: "Manual Match Vendor " + tag, amount: 88.5, external_id: "manual-match-" + crypto.randomUUID() }),
  });
  const candidates = await (await apiFetch(`/api/receipts/${receiptId}/candidates`)).json();
  const txId = candidates.candidates[0].id;
  const res = await apiFetch(`/api/receipts/${receiptId}/match`, { method: "POST", body: JSON.stringify({ transaction_id: txId }) });
  assert.equal(res.status, 200);
  const after = await (await apiFetch(`/api/receipts/${receiptId}/candidates`)).json();
  assert.equal(after.already_matched, true);
  assert.equal(after.transaction_id, txId);
});

// ---- Audit trail (Priority 6) ----

test("category create/rename/delete are all audited", async () => {
  const created = await (await apiFetch("/api/categories", { method: "POST", body: JSON.stringify({ name: "Audit Test Category " + crypto.randomUUID() }) })).json();
  await apiFetch(`/api/categories/${created.id}`, { method: "PATCH", body: JSON.stringify({ name: "Audit Test Renamed" }) });
  await apiFetch(`/api/categories/${created.id}`, { method: "DELETE" });
  const log = await (await apiFetch(`/api/audit-log?entity_type=category&entity_id=${created.id}`)).json();
  assert.deepEqual(log.rows.map((r) => r.action).sort(), ["create", "delete", "rename"]);
  assert.ok(log.rows.every((r) => r.actor === "captain"));
});

test("transaction edits are audited with old and new values", async () => {
  const boot = await (await apiFetch("/api/bootstrap")).json();
  const cat = boot.categories[0];
  await apiFetch("/api/transactions", {
    method: "POST",
    body: JSON.stringify({ transaction_date: "2026-09-18", vendor_raw: "Audit Trail Vendor", amount: 9, external_id: "test-audit-" + crypto.randomUUID() }),
  });
  const list = await (await apiFetch("/api/transactions?month=2026-09")).json();
  const tx = list.rows.find((r) => r.vendor_raw === "Audit Trail Vendor");
  await apiFetch(`/api/transactions/${tx.id}`, { method: "PATCH", body: JSON.stringify({ category_id: cat.id, notes: "audit note" }) });
  const log = await (await apiFetch(`/api/audit-log?entity_type=transaction&entity_id=${tx.id}`)).json();
  assert.equal(log.rows.length, 1);
  assert.equal(log.rows[0].new_data.category_id, cat.id);
  assert.equal(log.rows[0].old_data.category_id, null);
});

// ---- Automation vs human review (Priority 7) ----

test("system auto-match never sets captain_reviewed on the transaction", async () => {
  const tag = "ReviewTest" + crypto.randomUUID().slice(0, 8);
  const receiptId = await insertBareReceipt({ vendor: tag, amount: 61.2, receipt_date: "2026-09-23" });
  await pool.query("UPDATE receipts SET category_id=(SELECT id FROM categories LIMIT 1) WHERE id=$1", [receiptId]);
  await apiFetch("/api/transactions", {
    method: "POST",
    body: JSON.stringify({ transaction_date: "2026-09-23", vendor_raw: tag + " CO", amount: 61.2, external_id: "test-reviewflag-" + crypto.randomUUID() }),
  });
  const check = await (await apiFetch(`/api/receipts/${receiptId}/candidates`)).json();
  assert.equal(check.already_matched, true);
  const list = await (await apiFetch("/api/transactions?month=2026-09")).json();
  const tx = list.rows.find((r) => r.id === check.transaction_id);
  assert.equal(tx.captain_reviewed, false, "auto-matching is a system action, not captain review");
  assert.ok(tx.category_name, "category should still have been copied from the receipt");
});

// ---- Month close enforcement (Priority 8) ----

test("closed month blocks editing an existing transaction, and reopening requires a reason", async () => {
  const month = "2026-05";
  await apiFetch("/api/transactions", {
    method: "POST",
    body: JSON.stringify({ transaction_date: `${month}-15`, vendor_raw: "Close Test Vendor", amount: 5, external_id: "test-close-" + crypto.randomUUID() }),
  });
  const list0 = await (await apiFetch(`/api/transactions?month=${month}`)).json();
  const tx = list0.rows.find((r) => r.vendor_raw === "Close Test Vendor");
  // Close the month directly rather than through /api/close-month, so this test
  // is isolated from that endpoint's preconditions (covered by its own test above).
  await pool.query(
    "INSERT INTO month_closes(month_start,calculated_total,closed,closed_at) VALUES($1,0,true,NOW()) ON CONFLICT(month_start) DO UPDATE SET closed=true,closed_at=NOW()",
    [`${month}-01`]
  );
  await pool.query(
    "INSERT INTO audit_log(actor,action,entity_type,entity_id,source) VALUES('captain','month_close','month',$1,'test setup')",
    [month]
  );

  const editAfterClose = await apiFetch(`/api/transactions/${tx.id}`, { method: "PATCH", body: JSON.stringify({ notes: "should be blocked" }) });
  assert.equal(editAfterClose.status, 409);

  const importAfterClose = await apiFetch("/api/transactions", {
    method: "POST",
    body: JSON.stringify({ transaction_date: `${month}-20`, vendor_raw: "Blocked Import Vendor", amount: 3, external_id: "test-blocked-" + crypto.randomUUID() }),
  });
  const importBody = await importAfterClose.json();
  assert.equal(importBody.blocked_closed_month, 1);
  assert.equal(importBody.inserted, 0);

  const reopenNoReason = await apiFetch("/api/reopen-month", { method: "POST", body: JSON.stringify({ month }) });
  assert.equal(reopenNoReason.status, 400);

  const reopen = await apiFetch("/api/reopen-month", { method: "POST", body: JSON.stringify({ month, reason: "correcting a miscategorized charge" }) });
  assert.equal(reopen.status, 200);

  const editAfterReopen = await apiFetch(`/api/transactions/${tx.id}`, { method: "PATCH", body: JSON.stringify({ notes: "should work now" }) });
  assert.equal(editAfterReopen.status, 200);

  const log = await (await apiFetch(`/api/audit-log?entity_type=month&entity_id=${month}`)).json();
  assert.deepEqual(log.rows.map((r) => r.action).sort(), ["month_close", "month_reopen"]);
});

// ---- Owner approval thresholds (Priority 11) ----

// Owner approval on this boat happens before the charge, not after — so a
// transaction over threshold is a record of a decision already made, not an
// open one. It lands as "approved" directly, never sits as "needed".
test("transactions above the configured threshold record as already-approved; below it, no approval is required", async () => {
  const setRes = await apiFetch("/api/settings/owner-approval-threshold", { method: "PUT", body: JSON.stringify({ value: 1000 }) });
  assert.equal(setRes.status, 200);
  const tag = crypto.randomUUID();
  await apiFetch("/api/transactions", {
    method: "POST",
    body: JSON.stringify({ rows: [
      { transaction_date: "2026-09-19", vendor_raw: "Big Spend " + tag, amount: 5000, external_id: "big-" + tag },
      { transaction_date: "2026-09-19", vendor_raw: "Small Spend " + tag, amount: 50, external_id: "small-" + tag },
    ] }),
  });
  const list = await (await apiFetch("/api/transactions?month=2026-09")).json();
  assert.equal(list.rows.find((r) => r.vendor_raw === "Big Spend " + tag).approval_status, "approved");
  assert.equal(list.rows.find((r) => r.vendor_raw === "Small Spend " + tag).approval_status, "not_required");
  await apiFetch("/api/settings/owner-approval-threshold", { method: "PUT", body: JSON.stringify({ value: null }) });
});

// A captain can still hand-flag a transaction as "needed" (e.g. a genuine
// emergency purchase made without prior owner sign-off) and later approve it,
// which unblocks month close — the manual override path stays available even
// though the threshold no longer sets "needed" automatically.
test("captain can manually flag then approve a transaction, which unblocks month close", async () => {
  const boot = await (await apiFetch("/api/bootstrap")).json();
  const month = "2026-04";
  await apiFetch("/api/transactions", {
    method: "POST",
    body: JSON.stringify({ transaction_date: `${month}-05`, vendor_raw: "Approval Flow Vendor", amount: 500, external_id: "test-approval-" + crypto.randomUUID() }),
  });
  const list = await (await apiFetch(`/api/transactions?month=${month}`)).json();
  const tx = list.rows.find((r) => r.vendor_raw === "Approval Flow Vendor");
  assert.equal(tx.approval_status, "not_required");

  await apiFetch(`/api/transactions/${tx.id}`, { method: "PATCH", body: JSON.stringify({ approval_status: "needed" }) });
  const closeBlocked = await apiFetch("/api/close-month", { method: "POST", body: JSON.stringify({ month }) });
  const blockedBody = await closeBlocked.json();
  assert.equal(closeBlocked.status, 409);
  assert.ok(blockedBody.blockers.owner_approval_needed >= 1);

  const approveRes = await apiFetch(`/api/transactions/${tx.id}`, { method: "PATCH", body: JSON.stringify({
    category_id: boot.categories[0].id, approval_status: "approved", approval_note: "owner said go ahead",
  }) });
  assert.equal(approveRes.status, 200);
  const after = await (await apiFetch(`/api/transactions?month=${month}`)).json();
  const updated = after.rows.find((r) => r.id === tx.id);
  assert.equal(updated.approval_status, "approved");
  assert.equal(updated.approved_by, "captain");
  assert.ok(updated.approval_date);
});

// ---- Capital One reconciliation (Priority 9) ----

test("reconciliation: imported batch totals are computed, and matching balances mark it reconciled", async () => {
  const tag = crypto.randomUUID();
  const hash = "recon-hash-" + tag;
  const importRes = await apiFetch("/api/transactions", {
    method: "POST",
    body: JSON.stringify({
      file_hash: hash, source_filename: "recon-test.csv",
      rows: [
        { transaction_date: "2026-06-01", vendor_raw: "Recon Charge " + tag, amount: 100 },
        { transaction_date: "2026-06-02", vendor_raw: "Recon Refund " + tag, amount: -20 },
      ],
    }),
  });
  const importBody = await importRes.json();
  const batchId = importBody.batch_id;
  assert.ok(batchId);

  const before = await (await apiFetch(`/api/reconciliation/${batchId}`)).json();
  assert.equal(before.imported_row_count, 2);
  assert.equal(Number(before.imported_charge_total), 100);
  assert.equal(Number(before.imported_credit_total), -20);
  assert.equal(before.reconciliation_status, "needs_balances");

  // beginning 1000 + charges 100 + credits -20 = expected ending 1080
  const putRes = await apiFetch(`/api/reconciliation/${batchId}`, { method: "PUT", body: JSON.stringify({ beginning_balance: 1000, ending_balance: 1080 }) });
  const putBody = await putRes.json();
  assert.equal(putBody.reconciliation_difference, 0);
  // won't be "reconciled" yet since the imported transactions have no receipts/categories,
  // which is correct per the brief: exceptions must be resolved first, not just the math.
  assert.equal(putBody.reconciled, false);
});

test("reconciliation: mismatched ending balance is flagged, not silently accepted", async () => {
  const tag = crypto.randomUUID();
  const importRes = await apiFetch("/api/transactions", {
    method: "POST",
    body: JSON.stringify({ file_hash: "recon-mismatch-" + tag, source_filename: "mismatch.csv",
      rows: [{ transaction_date: "2026-06-03", vendor_raw: "Mismatch Vendor " + tag, amount: 50 }] }),
  });
  const batchId = (await importRes.json()).batch_id;
  const res = await apiFetch(`/api/reconciliation/${batchId}`, { method: "PUT", body: JSON.stringify({ beginning_balance: 500, ending_balance: 500 }) });
  const body = await res.json();
  assert.equal(body.reconciliation_difference, 50, "500 + 50 charge should not equal an ending balance of 500");
  assert.equal(body.reconciled, false);
});

// ---- Accountant exports (Priority 12) ----

test("monthly register export is a CSV with the expected columns and a known row", async () => {
  const tag = crypto.randomUUID();
  await apiFetch("/api/transactions", {
    method: "POST",
    body: JSON.stringify({ transaction_date: "2026-09-24", vendor_raw: "Export Test Vendor " + tag, amount: 12.34, external_id: "test-export-" + tag }),
  });
  const res = await apiFetch("/api/export/register?month=2026-09");
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /text\/csv/);
  const text = await res.text();
  assert.match(text, /^Transaction Date,Posted Date,Vendor,Amount,Category,Payment Method,Card\/Reference,Captain Reviewed,Receipt Attached,Owner Approval Status,Notes/);
  assert.match(text, new RegExp(`Export Test Vendor ${tag}`));
});

test("monthly register export supports an xlsx download for the accountant, with columns wide enough to show full vendor/category text", async () => {
  const tag = crypto.randomUUID();
  const longVendor = "A Very Long Provisioning Vendor Name That Would Get Clipped " + tag;
  await apiFetch("/api/transactions", {
    method: "POST",
    body: JSON.stringify({ transaction_date: "2026-09-24", vendor_raw: longVendor, amount: 12.34, external_id: "test-export-xlsx-" + tag }),
  });
  const res = await apiFetch("/api/export/register?month=2026-09&format=xlsx");
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /spreadsheetml/);
  const buf = Buffer.from(await res.arrayBuffer());
  assert.equal(buf.slice(0, 2).toString("hex"), "504b", "xlsx files are zip archives (PK header)");

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  const sheet = wb.worksheets[0];
  const row = sheet.getRows(2, sheet.rowCount - 1).find((r) => r.getCell(3).value === longVendor);
  assert.ok(row, "the long-vendor row should be present, unmodified");
  const vendorColWidth = sheet.getColumn(3).width;
  assert.ok(vendorColWidth >= longVendor.length, `vendor column (width ${vendorColWidth}) should be wide enough to show the full name (${longVendor.length} chars)`);
});

test("exception report lists uncategorized and unreviewed transactions", async () => {
  const tag = crypto.randomUUID();
  await apiFetch("/api/transactions", {
    method: "POST",
    body: JSON.stringify({ transaction_date: "2026-09-25", vendor_raw: "Exception Test Vendor " + tag, amount: 8, external_id: "test-exception-" + tag }),
  });
  const res = await apiFetch("/api/export/exceptions?month=2026-09");
  const body = await res.json();
  assert.ok(body.uncategorized.some((r) => r.vendor_raw === "Exception Test Vendor " + tag));
  assert.ok(body.unreviewed.some((r) => r.vendor_raw === "Exception Test Vendor " + tag));
});

// ---- Petty cash (Priority 10) ----

test("petty cash: expected ending balance = beginning + replenishments - cash expenses", async () => {
  const month = "2026-03";
  const tag = crypto.randomUUID();
  await apiFetch("/api/transactions", {
    method: "POST",
    body: JSON.stringify({ transaction_date: `${month}-10`, vendor_raw: "Petty Cash Test " + tag, amount: 40, payment_method: "cash", external_id: "test-pettycash-" + tag }),
  });
  const setRes = await apiFetch("/api/petty-cash", { method: "PUT", body: JSON.stringify({ month, beginning_balance: 500, replenishments: 100 }) });
  const setBody = await setRes.json();
  // 500 + 100 replenishment - at least the 40 we just posted (plus whatever else is in this seeded month)
  assert.ok(setBody.expected_ending_balance <= 560);

  const get = await (await apiFetch(`/api/petty-cash?month=${month}`)).json();
  assert.equal(get.beginning_balance, 500);
  assert.equal(get.replenishments, 100);
  assert.equal(get.counted_balance, null);
  assert.equal(get.difference, null);
});

test("petty cash: counting an actual balance shows the difference from expected", async () => {
  const month = "2026-02";
  const countRes = await apiFetch("/api/petty-cash", { method: "PUT", body: JSON.stringify({ month, beginning_balance: 300, replenishments: 0, counted_balance: 250 }) });
  const body = await countRes.json();
  assert.equal(body.expected_ending_balance, 300);
  assert.equal(body.counted_balance, 250);
  assert.equal(body.difference, -50);
});

// ---- Login page (cookie-session auth) ----

test("unauthenticated browser visit redirects to /login, not a bare 401", async () => {
  const res = await fetch(BASE + "/", { headers: { Accept: "text/html" }, redirect: "manual" });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get("location"), "/login");
});

test("/login page renders without auth", async () => {
  const res = await fetch(BASE + "/login");
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /Sign in/);
  assert.match(html, /M\/Y CARBON COPY/);
});

test("wrong password on /login shows an error, no cookie set", async () => {
  const res = await fetch(BASE + "/login", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: "username=test&password=wrong",
    redirect: "manual",
  });
  assert.equal(res.status, 401);
  assert.equal(res.headers.get("set-cookie"), null);
  assert.match(await res.text(), /Incorrect username or password/);
});

test("correct login sets a session cookie that authenticates subsequent requests", async () => {
  const res = await fetch(BASE + "/login", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: "username=test&password=test",
    redirect: "manual",
  });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get("location"), "/");
  const cookie = res.headers.get("set-cookie");
  assert.match(cookie, /^ccc_session=/);
  const sessionCookie = cookie.split(";")[0];
  const authed = await fetch(BASE + "/api/bootstrap", { headers: { Cookie: sessionCookie } });
  assert.equal(authed.status, 200);
});

test("Basic Auth still works for API clients that skip the login page", async () => {
  const res = await apiFetch("/api/bootstrap");
  assert.equal(res.status, 200);
});

test("ACME/domain-verification challenge path is reachable without auth", async () => {
  // Custom-domain SSL issuance needs an unauthenticated GET here to succeed.
  // Regression: the login middleware once blanket-401'd every path except
  // /login and /assets/, silently breaking domain verification.
  const res = await fetch(BASE + "/.well-known/acme-challenge/test-token");
  assert.notEqual(res.status, 401);
});

// ---- Runner ----

// ---- OCR reading rules (from the labeled-receipt scorecard, evals/) ----

test("ocr: total ignores the GST summary block and reads the real total", () => {
  const text = ["LIM SENG THO HARDWARE TRADING", "Date : 02/02/2018 10:06", "Subtotal : 7.00", "Total Incl. of GST 7.00",
    "Payment : 7.00", "Change Due : 0.00", "GST Summary Amount(RM) Tax(RM)", "SR @ 6% 6.60 0.40"].join("\n");
  assert.equal(parseOcrReceipt(text).amount, 7);
});

test("ocr: a tax-included note is not the total", () => {
  const text = ["KING'S CONFECTIONERY S/B", "Due 25.15", "Pay 25.15", "Change 0.00", "(Total Included GST @ 6% : 1.42)"].join("\n");
  assert.equal(parseOcrReceipt(text).amount, 25.15);
});

test("ocr: day-first dates are read when month-first is impossible, month-first wins when ambiguous", () => {
  assert.equal(isoReceiptDate("20/03/2018 7:07pm"), "2018-03-20");
  assert.equal(isoReceiptDate("22 Mar 2018 18:24"), "2018-03-22");
  assert.equal(isoReceiptDate("9/8/2026 10:25 AM"), "2026-09-08");
});

test("ocr: cash and masked-card payments are detected", () => {
  assert.equal(detectPaymentMethodFromText("Total 12.25\nCASH 50.00\nChange 37.75"), "cash");
  assert.equal(detectPaymentMethodFromText("MASTERCARD XXXXXXXXXXXX0945 43.96"), "credit_card");
});

test("ocr: vendor is the business name, not OCR junk above it", () => {
  const text = ["tan woon yann", "BOOK TA .K (TAMAN DAYA) SDN BHD", "789417-W"].join("\n");
  assert.match(parseOcrReceipt(text).vendor, /SDN BHD/);
});

test("saving a receipt keeps the OCR guess, and /api/ocr/corrections shows what the captain changed", async () => {
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
  const fd = new FormData();
  fd.append("files", new Blob([png], { type: "image/png" }), "guess-test-" + crypto.randomUUID() + ".png");
  fd.append("receipt_date", "2026-09-15"); fd.append("vendor", "Corrections Test Marine"); fd.append("amount", "12.34");
  fd.append("payment_method", "cash");
  fd.append("ocr_guess", JSON.stringify({ vendor: "Corections Test Marne", date: "2026-09-15", amount: 12.31, payment: "cash" }));
  const saved = await fetch(BASE + "/api/receipts", { method: "POST", headers: { Authorization: AUTH }, body: fd });
  assert.equal(saved.status, 201);
  const out = await (await apiFetch("/api/ocr/corrections")).json();
  const row = out.rows.find((r) => r.final.vendor === "Corrections Test Marine");
  assert.deepEqual(row.changed.sort(), ["total", "vendor"]);
});


test("folder inbox: loose consecutive photos group into one flagged receipt; total-photo tap and split work", async () => {
  const sharp = (await import("sharp")).default;
  const { readFileSync } = await import("node:fs");
  const png = readFileSync(new URL("./fixtures/ocr-self-test-receipt.png", import.meta.url));
  const variant = await sharp(png).extend({ bottom: 6, background: "white" }).png().toBuffer();
  const form = new FormData();
  form.append("mode", "auto");
  form.append("mtimes", JSON.stringify([1000000, 1005000]));
  form.append("files", new Blob([png]), "IMG_3001.png");
  form.append("files", new Blob([variant]), "IMG_3002.png");
  let r = await fetch(BASE + "/api/receipts/inbox", { method: "POST", headers: { Authorization: AUTH }, body: form });
  assert.equal(r.status, 200);
  let out = await r.json();
  assert.equal(out.groups.length, 1);
  assert.equal(out.groups[0].status, "ingested");
  assert.equal(out.groups[0].pages, 2);
  const id = out.groups[0].id;
  const row = (await pool.query("SELECT ocr_review_reasons,review_required FROM receipts WHERE id=$1", [id])).rows[0];
  assert.match(row.ocr_review_reasons, /photos grouped automatically/);
  assert.equal(row.review_required, true);
  r = await apiFetch(`/api/receipts/${id}/pages`);
  assert.equal((await r.json()).pages.length, 2);
  r = await apiFetch(`/api/receipts/${id}/total-page`, { method: "POST", body: JSON.stringify({ page: 1 }) });
  assert.equal(r.status, 200);
  assert.ok(Math.abs(Number((await r.json()).amount) - 87.46) < 0.02);
  // same files again = duplicate, nothing new
  const again = new FormData();
  again.append("mode", "auto"); again.append("mtimes", JSON.stringify([1000000, 1005000]));
  again.append("files", new Blob([png]), "IMG_3001.png"); again.append("files", new Blob([variant]), "IMG_3002.png");
  r = await fetch(BASE + "/api/receipts/inbox", { method: "POST", headers: { Authorization: AUTH }, body: again });
  assert.equal((await r.json()).groups[0].status, "duplicate");
  r = await apiFetch(`/api/receipts/${id}/split`, { method: "POST", body: JSON.stringify({ after: 1 }) });
  assert.equal(r.status, 200);
  const sp = (await r.json()).receipts;
  assert.equal(sp.length, 2);
  assert.equal((await pool.query("SELECT 1 FROM receipts WHERE id=$1", [id])).rowCount, 0);
  const folder = new FormData();
  folder.append("mode", "folder");
  folder.append("files", new Blob([await sharp(png).extend({ top: 9, background: "white" }).png().toBuffer()]), "a.png");
  folder.append("files", new Blob([await sharp(png).extend({ top: 11, background: "white" }).png().toBuffer()]), "b.png");
  r = await fetch(BASE + "/api/receipts/inbox", { method: "POST", headers: { Authorization: AUTH }, body: folder });
  out = await r.json();
  assert.equal(out.groups.length, 1);
  assert.equal(out.groups[0].pages, 2);
});

test("HEIC (iPhone) photos are converted and read, via /api/ocr and the folder inbox", async () => {
  const { readFileSync } = await import("node:fs");
  const heic = readFileSync(new URL("./fixtures/ocr-self-test-receipt.heic", import.meta.url));
  const form = new FormData();
  form.append("files", new Blob([heic]), "IMG_9001.HEIC");
  let r = await fetch(BASE + "/api/ocr", { method: "POST", headers: { Authorization: AUTH }, body: form });
  assert.equal(r.status, 200);
  assert.ok(Math.abs(Number((await r.json()).amount) - 87.46) < 0.02);
  const f2 = new FormData();
  f2.append("mode", "folder");
  f2.append("files", new Blob([heic]), "IMG_9002.HEIC");
  r = await fetch(BASE + "/api/receipts/inbox", { method: "POST", headers: { Authorization: AUTH }, body: f2 });
  const g = (await r.json()).groups[0];
  assert.equal(g.status, "ingested");
  const row = (await pool.query("SELECT amount,content_type FROM receipts WHERE id=$1", [g.id])).rows[0];
  assert.equal(row.content_type, "image/jpeg");
  assert.ok(Math.abs(Number(row.amount) - 87.46) < 0.02);
});

test("scanner-app PDFs: read via /api/ocr and the folder inbox; multi-page PDF is one receipt with pages", async () => {
  const { readFileSync } = await import("node:fs");
  const one = readFileSync(new URL("./fixtures/ocr-self-test-receipt.pdf", import.meta.url));
  const two = readFileSync(new URL("./fixtures/two-page.pdf", import.meta.url));
  const f1 = new FormData();
  f1.append("files", new Blob([one], { type: "application/pdf" }), "scan.pdf");
  let r = await fetch(BASE + "/api/ocr", { method: "POST", headers: { Authorization: AUTH }, body: f1 });
  assert.equal(r.status, 200);
  assert.ok(Math.abs(Number((await r.json()).amount) - 87.46) < 0.02);
  const f2 = new FormData();
  f2.append("mode", "auto");
  f2.append("files", new Blob([two], { type: "application/pdf" }), "Scan 2026-09-29.pdf");
  r = await fetch(BASE + "/api/receipts/inbox", { method: "POST", headers: { Authorization: AUTH }, body: f2 });
  const g = (await r.json()).groups[0];
  assert.equal(g.status, "ingested");
  assert.equal(g.pages, 2);
  const row = (await pool.query("SELECT amount,content_type,ocr_review_reasons FROM receipts WHERE id=$1", [g.id])).rows[0];
  assert.equal(row.content_type, "application/pdf");
  assert.ok(Math.abs(Number(row.amount) - 87.46) < 0.02);
  assert.match(row.ocr_review_reasons, /multi-page PDF/);
  assert.equal((await (await apiFetch(`/api/receipts/${g.id}/pages`)).json()).pages.length, 2);
  const again = new FormData();
  again.append("mode", "auto");
  again.append("files", new Blob([two], { type: "application/pdf" }), "Scan 2026-09-29.pdf");
  r = await fetch(BASE + "/api/receipts/inbox", { method: "POST", headers: { Authorization: AUTH }, body: again });
  assert.equal((await r.json()).groups[0].status, "duplicate");
});

test("vision second read: fills fields, flags disagreement with Tesseract, and falls back cleanly on API failure", async () => {
  const http = await import("node:http");
  const { readFileSync } = await import("node:fs");
  const { applyVision } = await import("../vision.js");
  // unit: agreement is corroborated, disagreement is flagged, nothing silently wins
  const tess = { vendor: "X", receipt_date: null, amount: 55.5, review_reasons: ["date", "total unverified"], suggested_category: "Fuel & Lubricants" };
  let o = applyVision(tess, { vendor: "WAWA", receipt_date: "2026-09-01", amount: 55.5, subtotal: null, tax: null, detected_payment_method: "credit_card" });
  assert.equal(o.vendor, "WAWA"); assert.equal(o.total_corroborated, true);
  assert.ok(!o.review_reasons.includes("date") && !o.review_reasons.includes("total unverified"));
  o = applyVision(tess, { vendor: "WAWA", receipt_date: "2026-09-01", amount: 55.58, subtotal: null, tax: null, detected_payment_method: null });
  assert.equal(o.amount, 55.58); assert.ok(o.review_reasons.includes("total disagrees with second read"));
  const { dateSanity } = await import("../vision.js");
  const now = new Date("2026-10-02T12:00:00Z");
  assert.ok(dateSanity({ receipt_date: "2024-06-14", review_reasons: [] }, now).review_reasons.includes("date looks wrong"));
  assert.ok(dateSanity({ receipt_date: "2026-12-01", review_reasons: [] }, now).review_reasons.includes("date looks wrong"));
  assert.equal(dateSanity({ receipt_date: "2026-09-20", review_reasons: [] }, now).review_reasons.length, 0);
  // integration: stub Anthropic API
  let mode = "ok";
  const srv = http.createServer((req, res) => {
    req.resume(); req.on("end", () => {
      if (mode === "fail") { res.statusCode = 500; return res.end("{}"); }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ content: [{ type: "text", text: JSON.stringify({ vendor: "Vision Marine", date: "2026-09-26", total: 87.46, subtotal: 80, tax: 7.46, payment_method: "credit_card", card_last4: null, total_page: 1 }) }] }));
    });
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  process.env.ANTHROPIC_API_KEY = "test"; process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${srv.address().port}`;
  try {
    const png = readFileSync(new URL("./fixtures/ocr-self-test-receipt.png", import.meta.url));
    const ask = async () => { const f = new FormData(); f.append("files", new Blob([png]), "r.png"); const r = await fetch(BASE + "/api/ocr", { method: "POST", headers: { Authorization: AUTH }, body: f }); assert.equal(r.status, 200); return r.json(); };
    let d = await ask();
    assert.equal(d.vendor, "Vision Marine"); assert.equal(d.total_corroborated, true);
    mode = "fail";
    d = await ask();
    assert.match(d.vendor, /HARBOR/); assert.ok(Math.abs(d.amount - 87.46) < 0.02);
  } finally { delete process.env.ANTHROPIC_API_KEY; delete process.env.ANTHROPIC_BASE_URL; srv.close(); }
});

test("azure document intelligence: PDF goes up as-is, fields come back, compare endpoint is gated", async () => {
  const http = await import("node:http");
  const { readFileSync } = await import("node:fs");
  const pdf = readFileSync(new URL("./fixtures/ocr-self-test-receipt.pdf", import.meta.url));
  let r = await apiFetch("/api/ocr/compare");
  assert.equal(r.status, 412);
  let sent = null, port, throttled = false;
  const srv = http.createServer((req, res) => {
    let body = ""; req.on("data", (c) => (body += c)); req.on("end", () => {
      res.setHeader("content-type", "application/json");
      if (req.method === "POST" && !throttled) { throttled = true; res.statusCode = 429; res.setHeader("retry-after", "0"); return res.end("{}"); }
      if (req.method === "POST") { sent = JSON.parse(body); res.statusCode = 202; res.setHeader("operation-location", `http://127.0.0.1:${port}/poll/1`); return res.end("{}"); }
      res.end(JSON.stringify({ status: "succeeded", analyzeResult: { documents: [{ fields: {
        MerchantName: { valueString: "Azure Marine", confidence: 0.97 }, TransactionDate: { valueDate: "2026-09-26", confidence: 0.99 },
        Total: { valueCurrency: { amount: 87.46 }, confidence: 0.98 }, Subtotal: { valueCurrency: { amount: 80 } }, TotalTax: { valueCurrency: { amount: 7.46 } } } }] } }));
    });
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r)); port = srv.address().port;
  process.env.AZURE_DI_ENDPOINT = `http://127.0.0.1:${port}`; process.env.AZURE_DI_KEY = "k";
  try {
    const f = new FormData(); f.append("files", new Blob([pdf], { type: "application/pdf" }), "s.pdf");
    r = await fetch(BASE + "/api/ocr", { method: "POST", headers: { Authorization: AUTH }, body: f });
    const d = await r.json();
    assert.equal(d.vendor, "Azure Marine"); assert.equal(d.amount, 87.46); assert.equal(d.total_corroborated, true);
    assert.equal(Buffer.from(sent.base64Source, "base64").toString("latin1", 0, 4), "%PDF");
    r = await apiFetch("/api/ocr/compare?limit=5");
    assert.equal(r.status, 200);
    assert.equal((await r.json()).engine, "azure-document-intelligence");
  } finally { delete process.env.AZURE_DI_ENDPOINT; delete process.env.AZURE_DI_KEY; srv.close(); }
});

test("test-receipt cleanup: preview first, removes a manual receipt + its transaction, audited, closed months untouched", async () => {
  const { readFileSync } = await import("node:fs");
  const sharp = (await import("sharp")).default;
  const png = await sharp(readFileSync(new URL("./fixtures/ocr-self-test-receipt.png", import.meta.url))).extend({ top: 13, background: "white" }).png().toBuffer();
  const f = new FormData();
  f.append("files", new Blob([png]), "t.png"); f.append("receipt_date", "2024-06-14"); f.append("vendor", "Palm Shore Market");
  f.append("amount", "25.19"); f.append("payment_method", "cash");
  let r = await fetch(BASE + "/api/receipts", { method: "POST", headers: { Authorization: AUTH }, body: f });
  assert.ok(r.status === 200 || r.status === 201);
  const rid = (await r.json()).id;
  assert.equal((await pool.query("SELECT count(*)::int n FROM transactions WHERE vendor_raw='Palm Shore Market'")).rows[0].n, 1, "one expense, not two");
  r = await apiFetch("/admin/twin-transactions");
  assert.equal((await r.json()).count, 0);
  const tx = (await pool.query("SELECT transaction_id FROM receipts WHERE id=$1", [rid])).rows[0].transaction_id;
  assert.ok(tx);
  await pool.query(`INSERT INTO transactions(transaction_date,posted_date,vendor_raw,vendor_normalized,amount,source,external_id,status,payment_method)
    SELECT transaction_date,posted_date,vendor_raw,vendor_normalized,amount,'manual','twin-'||id,'posted',payment_method FROM transactions WHERE id=$1`, [tx]);
  r = await apiFetch(`/admin/test-receipts?ids=${rid}`);
  const page = await r.text();
  assert.match(page, /AND its manual transaction/);
  assert.match(page, /2024-06-14/, "full date with year");
  assert.equal((await pool.query("SELECT 1 FROM receipts WHERE id=$1", [rid])).rowCount, 1);
  r = await apiFetch("/api/receipts/clear-tests", { method: "POST", body: JSON.stringify({ ids: [rid] }) });
  assert.equal(r.status, 200);
  assert.equal((await pool.query("SELECT 1 FROM receipts WHERE id=$1", [rid])).rowCount, 0);
  assert.equal((await pool.query("SELECT 1 FROM transactions WHERE id=$1", [tx])).rowCount, 0);
  assert.equal((await pool.query("SELECT 1 FROM transactions WHERE vendor_raw='Palm Shore Market'")).rowCount, 0, "duplicate copy removed too");
  assert.equal((await pool.query("SELECT 1 FROM audit_log WHERE action='removed_test_data' AND entity_id=$1", [String(rid)])).rowCount, 1);
});

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
