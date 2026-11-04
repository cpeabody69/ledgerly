// Map a statement line onto the small-service chart. This only names an account.
// It does not post a journal.

export function suggestedCode(description, amountCents) {
  const text = String(description || "").toLowerCase();
  if (/rent/.test(text)) return "6100";
  if (/software|subscription/.test(text)) return "6200";
  if (/marketing|\bads?\b/.test(text)) return "6300";
  if (/office|supplies|paper|ink/.test(text)) return "6400";
  if (/legal|accountant|professional/.test(text)) return "6500";
  if (/insurance/.test(text)) return "6600";
  if (/utility|utilities|electric/.test(text)) return "6700";
  if (/payroll|salary|wage/.test(text)) return "6000";
  if (/fee/.test(text)) return "6900";
  if (amountCents < 0) return "6400";
  return "4000";
}
