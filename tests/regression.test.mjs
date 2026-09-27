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

test("transactions above the configured threshold need approval; below it, they don't", async () => {
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
  assert.equal(list.rows.find((r) => r.vendor_raw === "Big Spend " + tag).approval_status, "needed");
  assert.equal(list.rows.find((r) => r.vendor_raw === "Small Spend " + tag).approval_status, "not_required");
  await apiFetch("/api/settings/owner-approval-threshold", { method: "PUT", body: JSON.stringify({ value: null }) });
});

test("captain can approve a flagged transaction, which then unblocks month close", async () => {
  await apiFetch("/api/settings/owner-approval-threshold", { method: "PUT", body: JSON.stringify({ value: 200 }) });
  const boot = await (await apiFetch("/api/bootstrap")).json();
  const month = "2026-04";
  await apiFetch("/api/transactions", {
    method: "POST",
    body: JSON.stringify({ transaction_date: `${month}-05`, vendor_raw: "Approval Flow Vendor", amount: 500, external_id: "test-approval-" + crypto.randomUUID() }),
  });
  const list = await (await apiFetch(`/api/transactions?month=${month}`)).json();
  const tx = list.rows.find((r) => r.vendor_raw === "Approval Flow Vendor");
  assert.equal(tx.approval_status, "needed");

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
  await apiFetch("/api/settings/owner-approval-threshold", { method: "PUT", body: JSON.stringify({ value: null }) });
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
