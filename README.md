# Ledgerly

Accounting workspace for a CPA firm. Phase 1 keeps the published Ledgerly shell and adds a real firm boundary: sign-in, sign-out, a client switcher, and staff invites.

Northstar is the firm. Haven Coffee Roasters, Brightline Labs, Mason & Finch, and Northstar Creative are that firm’s clients. Each client is a separate row. Nothing on the dashboard, transactions, accounting, invoices, or reports screen is a ledger.

## Run

Requires Node 22.

```bash
npm install
npm test
npm run dev
```

Open http://127.0.0.1:5173. The API listens on http://127.0.0.1:8787. `npm start` serves the production build from the API process.

## Synthetic sign-in

| Firm | Email | Password | Role |
| --- | --- | --- | --- |
| Northstar | olivia@northstarcreative.co | ledgerly-northstar | Owner (shown as Administrator) |
| Harbor Street Advisors | jordan@harborstreet.example | ledgerly-harbor | Owner |

An owner invites a staff or manager user from Settings. That person can sign in with the email and password entered on the invite. Staff and managers cannot invite.

## What is stored

Firms, users, clients, sessions, and audit events live in SQLite (`data/ledgerly.sqlite`, created on first start). Every row carries a firm. Client rows also carry that firm. The open client is stored on the server session, so a refresh keeps the sign-in and the selected client.

A user in one firm who requests another firm’s client id gets 404. The browser is not the system of record.

## Still the published picture

These screens still look like the published draft and do not write books:

- Dashboard, Transactions, Accounting, Invoices, and Reports, including their dollar figures
- Banking and Expenses placeholders
- The Settings overview cards
- The Clients banner counts, document-request copy, and review-queue copy
- The revenue and net-income text on the four original client rows (screen copy only, not stored)
- Add client, add company, composers, imports, exports, Ledger AI, notifications, and personal profile
