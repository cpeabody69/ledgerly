// Integer cents. Amounts cross the API as text so JSON numbers never become floats.

function invalid(message) {
  return Object.assign(new Error(message), { status: 400 });
}

export function parseCents(value, { blank = false } = {}) {
  if (typeof value !== "string") throw invalid("Enter amounts as text, such as 250.00.");
  let text = value.trim();
  if (text.startsWith("$")) text = text.slice(1).trim();
  if (text === "") {
    if (blank) return 0;
    throw invalid("Enter an amount.");
  }
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(text);
  if (!match) throw invalid("Use a positive amount with at most two decimal places.");
  const whole = match[1];
  const frac = (match[2] || "").padEnd(2, "0");
  if (whole.length > 13) throw invalid("That amount is too large.");
  const cents = Number(whole) * 100 + Number(frac);
  if (!Number.isSafeInteger(cents)) throw invalid("That amount is too large.");
  return cents;
}

export function addCents(left, right) {
  if (!Number.isSafeInteger(left) || !Number.isSafeInteger(right)) throw invalid("That amount is too large.");
  const sum = left + right;
  if (!Number.isSafeInteger(sum)) throw invalid("That amount is too large.");
  return sum;
}

export function formatMoney(cents) {
  if (!Number.isSafeInteger(cents)) throw invalid("That amount is too large.");
  const negative = cents < 0;
  const absolute = Math.abs(cents);
  const whole = Math.trunc(absolute / 100);
  const fraction = String(absolute % 100).padStart(2, "0");
  const grouped = String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${negative ? "-" : ""}$${grouped}.${fraction}`;
}
