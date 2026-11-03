// Synthetic chart for a small service business.
// A starting template for empty books. It is not GAAP guidance and not a complete chart.

export const CHART_TEMPLATE = "small-service-business";

export const TEMPLATE_NOTE =
  "A synthetic chart for a small service business. It is a starting template, not GAAP guidance.";

export const CASH_RULE =
  "Cash basis counts an entry only when a line posts to a cash account. Statements are not computed from this rule yet.";

export const CHART = [
  { code: "1000", name: "Cash", type: "asset", detailType: "Cash and cash equivalents", normalBalance: "debit", cash: 1 },
  { code: "1100", name: "Accounts receivable", type: "asset", detailType: "Accounts receivable", normalBalance: "debit", cash: 0 },
  { code: "1200", name: "Prepaid expenses", type: "asset", detailType: "Other current asset", normalBalance: "debit", cash: 0 },
  { code: "1500", name: "Equipment", type: "asset", detailType: "Fixed asset", normalBalance: "debit", cash: 0 },
  { code: "1510", name: "Accumulated depreciation", type: "asset", detailType: "Accumulated depreciation", normalBalance: "credit", cash: 0 },
  { code: "2000", name: "Accounts payable", type: "liability", detailType: "Accounts payable", normalBalance: "credit", cash: 0 },
  { code: "2100", name: "Credit card", type: "liability", detailType: "Credit card", normalBalance: "credit", cash: 0 },
  { code: "2200", name: "Sales tax payable", type: "liability", detailType: "Sales tax payable", normalBalance: "credit", cash: 0 },
  { code: "2500", name: "Note payable", type: "liability", detailType: "Long-term liability", normalBalance: "credit", cash: 0 },
  { code: "3000", name: "Owner's capital", type: "equity", detailType: "Owner's equity", normalBalance: "credit", cash: 0 },
  { code: "3100", name: "Owner's draws", type: "equity", detailType: "Owner's equity", normalBalance: "debit", cash: 0 },
  { code: "3200", name: "Retained earnings", type: "equity", detailType: "Retained earnings", normalBalance: "credit", cash: 0 },
  { code: "4000", name: "Service revenue", type: "income", detailType: "Service income", normalBalance: "credit", cash: 0 },
  { code: "4100", name: "Other income", type: "income", detailType: "Other income", normalBalance: "credit", cash: 0 },
  { code: "5000", name: "Cost of services", type: "expense", detailType: "Cost of services", normalBalance: "debit", cash: 0 },
  { code: "6000", name: "Payroll", type: "expense", detailType: "Payroll expense", normalBalance: "debit", cash: 0 },
  { code: "6100", name: "Rent", type: "expense", detailType: "Rent expense", normalBalance: "debit", cash: 0 },
  { code: "6200", name: "Software and subscriptions", type: "expense", detailType: "Software expense", normalBalance: "debit", cash: 0 },
  { code: "6300", name: "Marketing", type: "expense", detailType: "Marketing expense", normalBalance: "debit", cash: 0 },
  { code: "6400", name: "Office expenses", type: "expense", detailType: "Office expense", normalBalance: "debit", cash: 0 },
  { code: "6500", name: "Professional services", type: "expense", detailType: "Professional services", normalBalance: "debit", cash: 0 },
  { code: "6600", name: "Insurance", type: "expense", detailType: "Insurance expense", normalBalance: "debit", cash: 0 },
  { code: "6700", name: "Utilities", type: "expense", detailType: "Utilities expense", normalBalance: "debit", cash: 0 },
  { code: "6800", name: "Depreciation", type: "expense", detailType: "Depreciation expense", normalBalance: "debit", cash: 0 },
  { code: "6900", name: "Bank fees", type: "expense", detailType: "Bank fees", normalBalance: "debit", cash: 0 },
];
