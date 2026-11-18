# Avenue Pro development roadmap

This is the working plan for the ledgerly-stripe application. It records what is implemented, what is only partial, and what has not been started. A feature is not marked complete here unless the code exists and a server test covers the behavior.

Checkpoint before Phase 9: git tag `checkpoint-before-phase-9-aef1` at `a5c31a1`.

Avenue Pro is not production-ready. Automated tests do not replace an accounting review, a security review, or a decision to accept real client data.

## Product boundary

The app is a multi-tenant practice workspace for fictional firms. Plaid, QuickBooks, and Stripe stay in sandbox or test mode. The app does not file tax returns and does not collect real taxpayer documents.

Two invoice systems must stay separate:

- Client-ledger invoices (`invoices`) post to the selected client's books. Time can already draft one of those.
- Firm fee invoices (Phase 9) record what the accounting firm charges its client. They do not post to the client's general ledger and they do not charge a card.

Avenue Pro subscription billing is a third path. It is the firm's payment to Avenue, not the client's payment to the firm.

## Verified in this repository

Evidence is the module plus a passing test file. After Phase 9 the suite was 90 tests, 0 failed.

| Area | Evidence | Status |
| --- | --- | --- |
| Firm isolation | `server/tenancy.test.js`, `server/access.test.js` | Working for the flows those tests hit |
| Sign-in, roles, invitations | `server/auth.test.js`, `server/signin.test.js` | Working, including portal invitations |
| Client grants | `server/access.test.js` | Working |
| Audit log | `server/tenancy.test.js` and later modules | Working; not every action has a detail row |
| Client CRM and firm dashboard | `server/crm.test.js` | Working |
| Ledger, chart, journals | `server/ledger.test.js` | Working; posted entries cannot be edited |
| Statements | `server/statements.test.js` | Working for the covered periods |
| Payables and client invoices | `server/payables.test.js`, `server/invoices.test.js` | Working on the client ledger |
| Firm fee billing | `server/billing.test.js` | Working; no card charge and no ledger post |
| Plaid sandbox | `server/plaid.test.js` | Sandbox copy only; tokens are not a production vault |
| QuickBooks | `server/quickbooks.test.js` | OAuth sandbox, encrypted tokens, one company-info read. Not full sync |
| Work queues and schedules | `server/work.test.js`, `server/workflow.test.js` | Working |
| Monthly close and period lock | `server/close.test.js` | Working |
| Books-to-tax, sole proprietor, 2026 | `server/tax-calc.test.js`, `server/tax-intel.test.js` | Working as a planner, not a return |
| Client portal and documents | `server/portal.test.js`, `server/portal-desk.test.js`, `server/documents.test.js` | Working with the limits below |

## Phase 8 limits that remain

- Document encryption uses `LEDGERLY_DOCUMENT_KEY` when set. Otherwise it uses a development key written in the source.
- The upload check rejects a few known-bad signatures. It is not a malware scanner.
- The local server speaks HTTP. Transport encryption is not terminated here.
- Authenticator codes and accountant approval of document requests are off until turned on.
- Retention runs when an accountant asks. Nothing deletes files on a schedule.
- The portal screens were not exercised in a browser.

## Phase 9 — Firm billing

Implemented on `cursor/firm-billing-aef1`. Covered by `server/billing.test.js`.

- Fixed-fee, hourly, and recurring engagements.
- Draft invoices, accountant approval, recorded payments, and credit notes.
- Nonbillable time cannot be placed on a firm invoice.
- Aging buckets and a past-due work-queue task (`firm_invoice`) that keeps the same id on a second read.
- Revenue by service and an engagement profit figure only when a cost rate is stored.
- Stripe Connect stays off. The board says payments are not enabled.
- A firm invoice does not change the client ledger entry count.

Limits: recurring drafts run when someone calls the endpoint, not on a clock. Profit uses all billable hours for the client. The same hours can also sit on a client-ledger invoice; both responses say so, and neither side removes the other. No email reminder and no card charge. The billing screen was not exercised in a browser.

## Phases not started

These are the intended order. Do not skip one and call the product finished.

### Phase 10 — QuickBooks

Finish sandbox OAuth, refresh, disconnect, and read-only sync of accounts, transactions, customers, vendors, invoices, bills, and statements. Each client needs an authoritative system: Avenue books or QuickBooks. No silent overwrite. Write-back only after an accountant turns it on and a reconciliation test passes.

### Phase 11 — Books-to-tax beyond the sole proprietor

The 2026 sole-proprietor planner exists. Other entity types, state tax, and a firm-wide readiness view that is more than a count are not done. Do not file returns.

### Phase 12 — Financial health

Trends, aging, close progress, and tax readiness in one client view. Every alert needs a source record and a way to clear it. No opaque score.

### Phase 13 — Avenue subscription plans

Test-mode Stripe checkout exists in `server/subscription.js`. Plans, limits, and entitlements are not a single configuration. Do not turn on live billing.

### Phase 14 — Firm onboarding

Registration and email verification exist. A guided checklist, accounting-system choice, and a demo that never needs a real bank do not exist as one flow.

### Phase 15 — Avenue Pro branding

The interface still says Ledgerly in many places. Rename only with a pass that keeps the current screens working.

### Phase 16 — Security review

Isolation, sessions, and webhook signatures have tests. There is no threat model in the repo, no backup restore test, and no staging environment. Do not claim a certification.

### Phase 17 — Accounting accuracy

Journals must balance and the covered statements match the ledger. There is no pack of fictional companies with totals computed outside this codebase. Do not treat the current tests as an outside review.

### Phase 18 — Performance

No measured timings for 100 or 1,000 clients. Do not claim a scale number that was not measured.

### Phase 19 — Continuous integration

Tests run with `npm test`. There is no GitHub Actions workflow.

### Phase 20 — Beta

No landing page, pricing page, feedback loop, or production checklist beyond this document. Do not deploy for real client data.

## Rules for the next phases

- One phase at a time, on a branch `cursor/<name>-aef1`.
- Run the server suite after the phase.
- Fictional data and sandbox credentials only.
- Stop if a change would mix the client ledger with firm fees, or would overwrite QuickBooks and Avenue books at once.
