# Ledgerly

Accounting workspace for a CPA firm. Phase 1 keeps the published Ledgerly shell and adds a real firm boundary: sign-in, sign-out, a client switcher, and staff invites. Phase 2 makes the Accounting screen the books for the open client. Phase 3 stores that client’s bank and card activity. Phase 4 prepares profit and loss, the balance sheet, and cash flow from those books, and the dashboard metrics use the same numbers. Phase 5 makes the Clients screen the firm’s client list and review queue. Phase 6 stores document requests and synthetic files for that firm. Phase 7 keeps invoices for the open client: a draft, a sent receivable, and a recorded payment.

Northstar is the firm. Haven Coffee Roasters, Brightline Labs, Mason & Finch, and Northstar Creative are that firm’s clients. Each client has a separate chart, ledger, statement activity, and invoices.

## Run

Requires Node 22.

```bash
npm install
npm test
npm run dev
```

Open http://127.0.0.1:5173. The API listens on http://127.0.0.1:8787. `npm start` serves the production build from the API process.

## Synthetic sign-in

Each person has their own email and password. Signing in identifies that person and opens their firm. A password does not sign in a different person, including someone at the same firm or at another firm.

| Firm | Email | Password | Role |
| --- | --- | --- | --- |
| Northstar | olivia@northstarcreative.co | ledgerly-olivia | Organization Owner |
| Northstar | morgan@northstarcreative.co | ledgerly-morgan | Manager |
| Northstar | sam@northstarcreative.co | ledgerly-sam | Staff |
| Northstar | riley@northstarcreative.co | ledgerly-riley | Staff |
| Harbor Street Advisors | jordan@harborstreet.example | ledgerly-jordan | Organization Owner |
| Ledgerly Demo (fictional) | avery@ledgerly-demo.example | ledgerly-demo | Organization Owner |
| Brightline Labs (Northstar client) | casey@brightline.example | ledgerly-casey | Business Client |
| Cedar & Pine Goods (Harbor client) | rowan@cedar.example | ledgerly-rowan | Business Client |

An organization owner or administrator invites an employee from Settings and sets that person's password there. Nothing is emailed for that invite. The roles are organization owner, administrator, manager, accountant, staff, bookkeeper, and read-only employee. A read-only employee can open records and cannot change them. Staff and bookkeepers cannot invite. Clients do not register on the public form.

## Firm registration

The sign-in page links to Create a firm account. The form asks for full name, work email, password, password confirmation, and acceptance of the Terms and the Privacy notice. The account stays unverified until the verification link is opened. After that, the owner enters the firm name, business type, country, time zone, accounting method, and fiscal year. That creates the organization and makes the creator the organization owner.

After the firm is saved, a new firm chooses a Ledgerly plan and a seat count. Stripe Checkout in test mode starts that subscription. The workspace does not open for new work until the subscription is active. The checklist that follows can add a client, send a portal invitation, upload a sample document, and mark or skip the chart, sandbox bank, Work Queue, and reports. Skipped steps stay on the checklist until they are resumed. Opening the workspace requires an active subscription and at least one client, because the books are per client. Northstar, Harbor Street Advisors, and Ledgerly Demo are sample firms and stay usable without Stripe.

Email delivery is not configured. No mail provider is connected. Outside production, the API stores the verification, reset, and invitation links in a local development mailbox. Open it from the screen after registering, or request `GET /api/dev/mailbox?email=` on localhost. Set `LEDGERLY_DEV_MAILBOX=0` to hide that route. `NODE_ENV=production` hides it unless `LEDGERLY_DEV_MAILBOX=1`. Do not treat the mailbox as production email.

A client joins only when an owner, administrator, manager, or accountant creates the client and sends an invitation. The link expires in seven days, works once, and can be revoked. Accepting it creates the portal sign-in or signs in an existing portal password for that same client, then opens that client's portal. Deactivating portal access ends the client's sessions.

## Post a sample entry as Olivia

1. Sign in as `olivia@northstarcreative.co` / `ledgerly-olivia`.
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

## Invoices

The Invoices screen lists the open client’s invoices. Create invoice saves a draft and does not post. Sending posts accounts receivable and service revenue. A recorded payment posts cash and clears receivable. The status is paid only when those payments cover the invoice. Voiding posts a new reversing entry. Metrics, the “of N invoices” footer, and paging describe the stored list. The dashboard’s outstanding invoices use the same rows. Nothing charges a card.

## Expenses

The Expenses screen lists the open client’s bills and paid expenses. Saving an expense posts the expense account and either accounts payable or cash. The journal memo is the vendor, and the line amount is the expense amount. Unpaid bills appear on the dashboard. A firm setting can require a phase 6 receipt before that post; the API refuses the expense when the receipt is missing.

## Time

Each firm user has a staff record in addition to the phase 1 role. Time is entered against a client and a piece of work. Owners and managers can see time by client and open another person’s entries. A staff user sees and opens only their own. Creating an invoice from selected time saves one draft through the invoice flow. Its amount matches those hours. The ledger is unchanged until that invoice is sent. Wages are not posted.

## Client portal

A client signs in with their own account. Brightline Labs uses `casey@brightline.example` / `ledgerly-casey`. Cedar & Pine Goods uses `rowan@cedar.example` / `ledgerly-rowan`. Casey’s password does not sign in Rowan, and Rowan’s password does not sign in Casey. The page is the same Ledgerly sign-in. After sign-in the client sees that one client’s requests, files, and invoices. Submitting a file on an open request stores it and marks the request received. The firm’s open-request list updates when that person signs back in. Journal, statement, and other-client routes answer 404. The client does not post journal entries, send invoices, or open the firm sidebar.

## Tax readiness

The Tax screen reads the open client’s books for the current season. The checklist counts uncategorized transactions, reconciliations left unfinished after a completed reconciliation, open document requests, and invoices that are still sent or partially paid. A person sets the workflow to not started, gathering, in review, or blocked, and can assign it and say what is blocked. Each change records that firm user. Notes and workpapers are stored on the season. The screen does not compute tax or send anything to a tax authority.

## Assistant

Explore Ledger AI opens an assistant for the open client. It reads that client’s statements, uncategorized lines, missing documents, and tax checklist, and it can draft a journal. The draft stays off the ledger until a person posts it with New journal entry. Suggestions are marked AI-generated and carry a confidence indicator. Each recommendation and each human approval is stored.

The model provider is configuration. Set `LEDGERLY_MODEL_PROVIDER`, `LEDGERLY_MODEL_API_KEY`, and `LEDGERLY_MODEL_URL`. `LEDGERLY_MODEL_NAME` selects the model; when it is empty, the request asks the endpoint for its reasoning model, with structured output and the read-only tools. No key means the same tools run on the stored books and the assistant says the external model is not configured. Client figures stay in Ledgerly. This build uses synthetic clients and does not train on them.

## Firm subscription

This is a test-mode gate. It is not production-ready. There is no live billing, no tax calculation, and no claim that a card was charged.

Settings shows Ledgerly’s plan for the firm. Sample firms (Northstar, Harbor Street Advisors, and Ledgerly Demo) stay on the Practice plan without a Stripe customer. An owner of a sample firm can still change the seat count and record a firm payment. That payment is stored on the firm. It does not post a journal entry, invoice, bill, or balance on a client.

A firm created through `/register` is different. After email verification and firm creation, the owner picks Practice or Firm and a seat count. Continue to Stripe test checkout only when `STRIPE_SECRET_KEY` is an `sk_test_` key and the matching price id is set. A live key is refused. If those values are missing, the plan screen says test keys are not configured and does not crash. The secret key, webhook secret, and price ids stay in the server environment. They are not written into the browser bundle.

Stripe Checkout is test mode. The return URL asks the API to read that Checkout session and store the Stripe customer id and subscription id on the firm subscription, never on a client. `POST /api/stripe/webhook` accepts `checkout.session.completed`, subscription created/updated/deleted, `invoice.paid`, and `invoice.payment_failed`. The stored status is active, past due, or canceled. An active subscription allows normal firm work. Past due or canceled leaves the books readable and blocks new clients, journal entries, invoices, bills, and invites until it is paid. Adding an employee uses a seat. A full seat count blocks the next invite until the firm raises the quantity on the Stripe test subscription. A client portal user is not a seat.

Copy `.env.example` to `.env` and set:

```
STRIPE_SECRET_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...
STRIPE_PRICE_PRACTICE=price_...
STRIPE_PRICE_FIRM=price_...
```

Restart the API after saving `.env`. In the Stripe dashboard, create two recurring test prices and use card `4242 4242 4242 4242` with any future expiry and any CVC. That card is Stripe’s published test card, not a Ledgerly secret.

Local webhook, from another terminal, after [the Stripe CLI](https://docs.stripe.com/stripe-cli) is logged into test mode:

```bash
stripe listen --forward-to localhost:8787/api/stripe/webhook
```

Put the CLI’s `whsec_` value in `STRIPE_WEBHOOK_SECRET` and restart the API. Returning from Checkout also confirms the session, so the firm can become active without the CLI. `stripe trigger customer.subscription.updated` is a way to move a test subscription to past due or canceled. Refresh status on the plan screen reads the subscription back from Stripe.

What this build does not do: production checkout, a Stripe Customer Portal, automatic email for failed payments, or proration invoices posted into a client’s books. Seat changes call the Stripe subscription update in test mode. They do not post a journal entry.

## Plaid sandbox

Banking connects a sandbox bank for the open client through Plaid Link. The public token is exchanged on the server. The access token is stored in the database and is not sent back to the browser. Accounts, balances, connection status, sync history, and sync errors show on Banking. Each imported line keeps its description, date, amount, and merchant name, and lands on the existing review list with a suggested chart account. A suggestion does not post. A second sync does not insert the same line again. A journal is posted only when a person approves that suggestion or saves a different category, through the existing categorize action. Reconciliation uses the existing statement reconciliation. Disconnecting stops new lines and leaves the ones already imported.

Copy `.env.example` to `.env` in the repository root. `server/index.js` reads that file when the API process starts (`npm run dev` and `npm start`). Put the sandbox client id and sandbox secret from the Plaid dashboard (Team Settings → Keys, Sandbox) in `.env`. Set `PLAID_ENV=sandbox`. Restart the API after saving `.env`. The file is gitignored. Variables already present in the process environment are left as they are. No other Plaid variables are read.

If `PLAID_CLIENT_ID` or `PLAID_SECRET` is unset, or `PLAID_ENV` is not `sandbox`, Connect Bank Account stays clickable and shows that failure on the Banking page. Plaid Link opens only after the API has those three sandbox values.

Sandbox test, after the API has restarted with those three values:

1. Sign in and open a client. Go to Banking.
2. Choose Connect Bank Account. Plaid Link opens.
3. Search for First Platypus Bank (`ins_109508`), the non-OAuth sandbox institution in [Plaid’s sandbox institution list](https://plaid.com/docs/sandbox/institutions/).
4. Sign in with the sandbox username `user_good` and password `pass_good` from [Plaid’s sandbox test credentials](https://plaid.com/docs/sandbox/test-credentials/). These are Plaid’s published test user, not a Ledgerly secret.
5. Select the accounts Link offers and finish. Banking shows the connected accounts and their balances.
6. Open Transactions. The imported lines are For review, with a suggested category and no journal. Approve one, or change the account and save. That is the post. The others stay off the trial balance.
7. Choose Sync transactions. The same lines are not added again.

## QuickBooks Online sandbox

Settings → Integrations shows QuickBooks Online for the open client. Connect QuickBooks starts Intuit’s OAuth 2.0 authorization only when `QUICKBOOKS_CLIENT_ID`, `QUICKBOOKS_CLIENT_SECRET`, `QUICKBOOKS_REDIRECT_URI`, and `QUICKBOOKS_ENV=sandbox` are set. If they are missing, or the environment is not `sandbox`, the button explains that and no company is marked connected. A connection is stored only after Intuit’s token endpoint returns an access token and a refresh token, and the callback includes a realm id. That realm id is the QuickBooks company id. The company name comes from the CompanyInfo response. The access token and refresh token are encrypted with the client secret and are not returned to the browser or written to logs.

Disconnect clears the stored tokens and asks Intuit to revoke the refresh token. Sync calls the sandbox query API for customers, vendors, accounts, purchases (transactions), invoices, and payments. Ids Intuit returns are stored on this firm. A repeated id is rejected. Nothing from QuickBooks is posted into the client’s ledger, invoices, or bank activity. Webhooks require `QUICKBOOKS_WEBHOOK_VERIFIER`. The handler checks the `intuit-signature` HMAC and rejects a request that does not match. A valid webhook is recorded. It does not import records by itself.

Copy the names from `.env.example`. For `npm run dev`, set `QUICKBOOKS_REDIRECT_URI` to `http://127.0.0.1:5173/api/quickbooks/callback` and register that same URI on the Intuit sandbox app. Restart the API after saving `.env`. This build does not include Intuit app credentials, and it cannot finish a live sandbox connect until those exist.

## Fictional demo

The fictional demo is its own firm, Ledgerly Demo (fictional). Sign in as `avery@ledgerly-demo.example` / `ledgerly-demo`. That sign-in opens the three fictional businesses: a service studio, a retail shop, and a repair contractor. The sidebar names the firm under the open client, and Demo is in that firm’s sidebar. A paying firm such as Northstar or Harbor Street Advisors does not list Demo, and its sign-in opens that firm’s own clients.

Reset demo data deletes and recreates only the demo firm. It does not change Northstar, Harbor Street Advisors, or any other firm. Run accounting checks runs the book checks and stores pass or fail on the demo firm. A passing result is not a certification or an audit opinion. Nothing on the demo is a live bank, and the clients do not store tax identifiers.

The same actions are `POST /api/demo/reset` and `POST /api/demo/checks` while signed in to the demo firm. `GET /api/demo` reads the page. Another firm’s session gets 404 and does not receive the demo clients, books, tasks, documents, or users.

## Still the published picture

These screens still look like the published draft and do not read the ledger:

- The dashboard’s recent transactions and cash-flow card
- The Banking overview cards, and the Settings overview, activity, and rules cards
- Add company, exports other than a statement, notifications, and personal profile
- Budget vs. actuals, accounts receivable, and expense summary, which stay disabled
