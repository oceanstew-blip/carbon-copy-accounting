# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Solo user: the captain of M/Y Carbon Copy, a privately owned U.S.-flagged motor yacht (not a charter vessel). The captain is the only person who opens the app day to day. The owner and the shore-side accountant receive output from it (CSV exports, exception reports) but do not log in themselves. Design for one operator working through routine bookkeeping, not for multiple roles or a team.

## Product Purpose

A captain-simple vessel expense and bookkeeping-control system. Crew/captain documents expenses (receipts, Capital One card statement, cash/check/wire); the system organizes and controls the books; the captain handles exceptions and approvals; the shore-side accounting office receives clean, complete, reliable records. It exists to remove the captain's bookkeeping burden without asking them to become an accountant, and to catch the specific failure modes that plague informal boat bookkeeping: lost receipts, silently duplicated or dropped charges, categories nobody reviewed, a "closed" month that quietly reopens.

## Positioning

Not a scaled-down version of enterprise yacht-management or charter-accounting software (Voly, DeepBlue, IDEA) — those solve fleet/charter problems this vessel doesn't have (APA, multi-currency, multi-vessel). This is purpose-built for exactly one private U.S.-flagged yacht, one card, one currency, one operator, with real accounting controls (audit trail, real month-close locking, scored receipt matching, owner-approval thresholds) that a generic expense app doesn't offer at this scale.

## Operating Context

Routine cycle: photograph/upload a receipt → OCR reads what it can → captain confirms/corrects → payment method determines the flow (cash/check/wire post immediately; credit card waits to match the Capital One statement). Periodically: import the Capital One CSV, reconcile the statement (beginning/ending balance the captain reads off the real statement), resolve any suspected duplicates or unmatched receipts, close the month. Owner-approval threshold flags large expenses for a separate approve/decline step. Petty cash gets counted and reconciled against the ledger periodically. Used aboard the vessel — likely a laptop or tablet, not necessarily a large monitor, possibly with unreliable connectivity in port/at anchor.

## Capabilities and Constraints

- One vessel, one Capital One card (last 4 "0945"), USD only, no multi-currency, no charter APA, no fleet features, no payroll — deliberately narrow scope (see repo's `ponytail:`-style scope-limit comments).
- Payment methods: credit card, wire, check, cash — each has different posting rules (cash/check/wire post immediately as transactions; credit card waits for statement match).
- Real accounting controls already implemented server-side: audit log, scored receipt-matching (not just amount+date), import-batch dedup, real month-close locking with required-reason reopen, owner-approval thresholds, petty-cash reconciliation, Capital One statement reconciliation, CSV/exception exports for the accountant.
- Current frontend (`public/index.html`, `app.js`, `style.css`) is a single-page app with tab-style nav (Dashboard, Transactions, Receipt Inbox, Import, Reports, Categories & Rules, System Check) talking to a JSON API. This is the incumbent implementation — functionally complete, visually plain (generic SaaS dashboard look: white cards, blue/aqua accent, soft shadows, Inter font).
- Backend is a hand-rolled Express + Postgres app on Railway; no frontend framework or build step currently — vanilla JS/CSS served as static files.

## Brand Commitments

Boat name "M/Y Carbon Copy" and the app name "Carbon Copy Accounting" are fixed. No logo, photography, or other brand assets exist yet — captain confirmed text/data-only for now, nothing to source or wait on.

## Evidence on Hand

None — no photos, logo, or other real assets currently available or planned for this pass. Design must carry the identity through typography, color, layout, and data presentation alone, not imagery.

## Product Principles

1. **One operator, not a team** — every screen should assume a single tired person doing bookkeeping between other jobs, not a multi-role enterprise tool.
2. **Boring math, trustworthy surface** — this touches real money on someone else's boat; visual confidence (clarity, precision, no ambiguity in numbers/status) matters more than decoration.
3. **Exceptions should be impossible to miss** — the product's whole value is catching what generic tools silently drop (duplicates, missing receipts, unreviewed transactions); the design should make those states visually loud, not buried in a muted gray row.
4. **Marine, not maritime-cute** — the vessel context is real (captain, vessel, statement, dockage) but the audience is a working captain, not a tourist; avoid anchor-emoji/nautical-kitsch treatment.
5. **Nothing invented** — no fabricated data, testimonials, or decorative photography; every number on screen is real.
