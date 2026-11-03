# Ledgerly

Accounting workspace for a CPA firm. Phase 1 keeps the published Ledgerly shell and adds a real firm boundary: sign-in, sign-out, a client switcher, and staff invites. Phase 2 makes the Accounting screen the books for the open client. Phase 3 stores that client’s bank and card activity. Phase 4 prepares profit and loss, the balance sheet, and cash flow from those books, and the dashboard metrics use the same numbers. Phase 5 makes the Clients screen the firm’s client list and review queue. Phase 6 stores document requests and synthetic files for that firm.

Northstar is the firm. Haven Coffee Roasters, Brightline Labs, Mason & Finch, and Northstar Creative are that firm’s clients. Each client has a separate chart, ledger, and statement activity. Invoices stay the published picture. They do not read these books.

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

An owner invites a staff or manager user from Settings. That person can sign in with the email and password entered on the invite. Staff and managers cannot invite. Any signed-in member of the firm can post a journal entry to the open client.

## Post a sample entry as Olivia

1. Sign in as `olivia@northstarcreative.co` / `ledgerly-northstar`.
2. The open client is Northstar Creative. If it is not, switch to Northstar Creative.
3. Open Accounting. The chart is the small-service template and the three cards are `$0.00` until something is posted.
4. Choose **New journal entry**. This is a journal form, not the transaction composer.
5. Date `2026-11-03`. Memo `Sample service income`.
6. First line: `1000 Cash`, debit `250.00`. Second line: `4000 Service revenue`, credit `250.00`.
7. Choose **Post entry**.

The trial balance then shows Cash `$250.00` in the debit column and Service revenue `$250.00` in the credit column. The cards read assets `$250.00`, liabilities `$0.00`, and equity `$250.00`. Switch to Haven Coffee Roasters and those books stay at zero. Amounts are text such as `250.00`. An unbalanced entry is rejected and does not appear. A posted entry is not edited or deleted in place.

## Import statement activity

On Banking, add an account such as `Operating checking`. That account is not a live bank connection. On Transactions, choose Import and use a CSV:

```csv
date,description,amount
2026-05-12,Northwind studio deposit,500.00
2026-05-18,Paper and ink,-42.50
2026-04-03,April paper order,-15.00
```

Open a line, choose a category, and save. Saving posts a new balanced journal. Exclude does the same, to owner’s equity. The counts at the top match the lines in the selected period. April is empty only when that client has no April activity. On Banking, check the cleared lines and enter the statement ending balance. Complete reconciliation is saved only when the difference is zero, and it does not change the lines or the journals.

## What is stored

Firms, users, clients, sessions, and audit events live in SQLite (`data/ledgerly.sqlite`, created on first start). Each client also gets an empty chart, a books policy (accrual basis, fiscal year starting in January), journal tables, and empty bank-activity tables. Every journal row carries the firm, the client, the user who posted it, and the time. Money is stored as integer cents. Posting runs in a database transaction and is kept only when the lines balance. Categorizing a statement line posts a new journal. It does not edit an older one.

The chart is a synthetic small-service template, marked as a template, not GAAP guidance. Account `1000 Cash` is marked as the cash account. Cash basis counts a journal entry only when a line posts to that account, so an accrual to accounts receivable is left out. Profit and loss, the balance sheet, and cash flow use the open client’s ledger for the selected period and basis. Export downloads that statement. The four dashboard metrics and the revenue chart use the same totals. A percent appears only when the prior period has an amount to compare.

A user in one firm who requests another firm’s client id gets 404. The browser is not the system of record. The open client is stored on the server session, so a refresh keeps the sign-in and the selected client.

## Clients

The Clients screen and the company switcher list the same clients for the signed-in firm. Active clients, ready to review, and open requests are counts of those records. Add client creates a client and an empty chart. Search filters the table. Revenue and net income on a row are that client’s May accrual statement; a figure that is not computed is left blank. Books updated is the latest journal or statement date. The review queue lists clients with uncategorized statement lines or accounts that still have uncleared lines. Review opens that work. Categorizing a line lowers the uncategorized count. Open requests count the firm’s stored document requests that are still open. Harbor Street Advisors does not see Northstar’s clients.

## Documents

Request documents creates an open request on a client in the signed-in firm. The client file list and the receipt modal store a synthetic file and attach it to that request or to a transaction. View downloads the stored bytes. Removing a file writes an audit event, and removing the last file on a request opens it again. A file belongs to one firm. Another firm’s user gets no list entry and no bytes. There is no sharing link.

## Still the published picture

These screens still look like the published draft and do not read the ledger:

- The dashboard’s recent transactions, cash-flow card, outstanding invoices, and upcoming bills
- Invoices
- The Expenses placeholder
- The Settings overview cards
- Add company, the invoice composer, exports other than a statement, Ledger AI, notifications, and personal profile
- Budget vs. actuals, accounts receivable, and expense summary, which stay disabled
