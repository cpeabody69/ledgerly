// Sole-proprietor planning math. Results are rounded to the nearest dollar,
// the same way a Form 1040 line is rounded. This is not a return.
import {
  ADDITIONAL_MEDICARE,
  FILING_STATUSES,
  ORDINARY_BRACKETS,
  QBI_THRESHOLD,
  RETIREMENT,
  RULES_VERSION,
  RULES_YEAR,
  SECTION_179_LIMIT,
  SELF_EMPLOYMENT,
  STANDARD_DEDUCTION,
  rulesForYear,
} from "./tax-rules.js";

export function nearestDollar(cents) {
  const sign = cents < 0 ? -1 : 1;
  return sign * Math.round(Math.abs(cents) / 100) * 100;
}

export function ordinaryTaxCents(filingStatus, taxableCents) {
  const rows = ORDINARY_BRACKETS[filingStatus];
  if (!rows || taxableCents <= 0) return 0;
  const row = rows.find((item) => item.upTo == null || taxableCents <= item.upTo) || rows[rows.length - 1];
  const raw = row.baseCents + ((taxableCents - row.floor) * row.rate) / 100;
  return nearestDollar(Math.round(raw));
}

export function selfEmploymentTax(profitCents, socialSecurityWagesCents = 0) {
  if (profitCents <= 0) return { taxCents: 0, deductionCents: 0, netEarningsCents: 0, socialSecurityCents: 0, medicareCents: 0 };
  const netEarningsCents = nearestDollar(Math.round((profitCents * SELF_EMPLOYMENT.factorBps) / 10000));
  if (netEarningsCents < SELF_EMPLOYMENT.minimumNetEarnings) {
    return { taxCents: 0, deductionCents: 0, netEarningsCents, socialSecurityCents: 0, medicareCents: 0 };
  }
  const room = Math.max(0, SELF_EMPLOYMENT.wageBase - Math.max(0, socialSecurityWagesCents));
  const socialSecurityBase = Math.min(netEarningsCents, room);
  const socialSecurityCents = nearestDollar(Math.round((socialSecurityBase * SELF_EMPLOYMENT.socialSecurityRateBps) / 10000));
  const medicareCents = nearestDollar(Math.round((netEarningsCents * SELF_EMPLOYMENT.medicareRateBps) / 10000));
  const taxCents = socialSecurityCents + medicareCents;
  return {
    taxCents,
    deductionCents: nearestDollar(Math.round(taxCents / 2)),
    netEarningsCents,
    socialSecurityCents,
    medicareCents,
  };
}

function additionalMedicareCents(filingStatus, wagesCents, netEarningsCents) {
  const threshold = ADDITIONAL_MEDICARE.threshold[filingStatus];
  if (!threshold || netEarningsCents <= 0) return 0;
  const excess = wagesCents + netEarningsCents - threshold;
  if (excess <= 0) return 0;
  const base = Math.min(netEarningsCents, excess);
  return nearestDollar(Math.round((base * ADDITIONAL_MEDICARE.rateBps) / 10000));
}

function blank(status, missing, limitations, assumptions) {
  return {
    status,
    rulesVersion: status === "calculated" ? RULES_VERSION : "",
    rulesYear: RULES_YEAR,
    incomeTaxCents: null,
    selfEmploymentTaxCents: null,
    additionalMedicareCents: null,
    qbiDeductionCents: null,
    taxableIncomeCents: null,
    totalCents: null,
    filesReturn: false,
    transmits: false,
    missing,
    limitations,
    assumptions,
  };
}

export function planSoleProp({
  taxYear = RULES_YEAR,
  entityType = "sole_proprietor",
  filingStatus = "",
  scheduleCProfitCents = 0,
  otherWagesCents = null,
  socialSecurityWagesCents = null,
  retirementDeductionCents = 0,
} = {}) {
  const assumptions = [
    "Results round to the nearest dollar.",
    "The standard deduction is used. Itemized deductions are not calculated.",
    "This is a planning estimate. It is not a return and it is not transmitted.",
  ];
  const limitations = [
    "State tax is not calculated.",
    "The qualified business income deduction is only the 20 percent amount below the income threshold. The minimum deduction, specified-service limits, and wage or property limits are not applied.",
    "A business loss is netted against entered wages. Basis, at-risk, and passive limits are not applied.",
    "Credits, dependents, and the additional standard deduction for age or blindness are not applied.",
  ];
  if (!rulesForYear(taxYear)) {
    return blank("no_rules", [`No federal planning rules are loaded for ${taxYear}.`], limitations, assumptions);
  }
  if (entityType === "corporation" || entityType === "partnership") {
    return blank(
      "unsupported",
      [],
      ["Individual tax calculations are not applied to a corporation or a partnership.", ...limitations],
      assumptions,
    );
  }
  const missing = [];
  if (entityType !== "sole_proprietor") missing.push("Choose sole proprietor before an estimate is calculated.");
  if (!FILING_STATUSES.includes(filingStatus)) missing.push("Choose a filing status.");
  if (otherWagesCents == null) missing.push("Enter other wages, or enter 0 when there are none.");
  if (missing.length) return blank("missing", missing, limitations, assumptions);

  const wages = Math.max(0, otherWagesCents);
  const ssWages = socialSecurityWagesCents == null ? wages : Math.max(0, socialSecurityWagesCents);
  if (socialSecurityWagesCents == null) assumptions.push("Social Security wages were assumed equal to the other wages entered.");
  const profit = scheduleCProfitCents;
  const se = selfEmploymentTax(Math.max(0, profit), ssWages);
  const extraMedicare = additionalMedicareCents(filingStatus, wages, se.netEarningsCents);
  const retirement = Math.max(0, retirementDeductionCents || 0);
  const agi = wages + profit - se.deductionCents - retirement;
  const standard = STANDARD_DEDUCTION[filingStatus];
  const beforeQbi = Math.max(0, agi - standard);
  let qbi = 0;
  if (profit > 0 && beforeQbi > 0) {
    if (beforeQbi > QBI_THRESHOLD[filingStatus]) {
      limitations.push("Qualified business income deduction was not calculated because income is above the threshold.");
    } else {
      const fromProfit = nearestDollar(Math.round(profit * 0.2));
      const fromIncome = nearestDollar(Math.round(beforeQbi * 0.2));
      qbi = Math.min(fromProfit, fromIncome, beforeQbi);
    }
  }
  const taxable = Math.max(0, beforeQbi - qbi);
  const incomeTax = ordinaryTaxCents(filingStatus, taxable);
  const total = incomeTax + se.taxCents + extraMedicare;
  return {
    status: "calculated",
    rulesVersion: RULES_VERSION,
    rulesYear: RULES_YEAR,
    incomeTaxCents: incomeTax,
    selfEmploymentTaxCents: se.taxCents,
    additionalMedicareCents: extraMedicare,
    qbiDeductionCents: qbi,
    taxableIncomeCents: taxable,
    standardDeductionCents: standard,
    halfSelfEmploymentCents: se.deductionCents,
    netEarningsCents: se.netEarningsCents,
    totalCents: total,
    filesReturn: false,
    transmits: false,
    missing: [],
    limitations,
    assumptions,
  };
}

export function retirementScenario(baseProfitCents, filingStatus, kind, requestedCents, socialSecurityWagesCents = 0) {
  const se = selfEmploymentTax(Math.max(0, baseProfitCents), socialSecurityWagesCents);
  const sepBase = Math.max(0, baseProfitCents - se.deductionCents);
  const sepLimit = nearestDollar(Math.round((sepBase * RETIREMENT.sepRateBps) / 10000));
  const cap = kind === "sep" ? sepLimit : RETIREMENT.iraLimit;
  const allowed = Math.max(0, Math.min(requestedCents, cap));
  return {
    allowedCents: allowed,
    capCents: cap,
    reducesSelfEmployment: false,
    note: kind === "sep"
      ? "The SEP amount uses 20 percent of profit after the deductible half of self-employment tax. It reduces the income-tax estimate and does not reduce self-employment tax."
      : "The IRA amount is capped at the planning limit. It reduces the income-tax estimate and does not reduce self-employment tax.",
  };
}

export function depreciationScenario(requestedCents) {
  const allowed = Math.max(0, Math.min(requestedCents, SECTION_179_LIMIT));
  return {
    allowedCents: allowed,
    capCents: SECTION_179_LIMIT,
    note: allowed < requestedCents
      ? "The depreciation scenario is capped at the section 179 planning limit. It does not post to the books."
      : "The depreciation scenario reduces planned profit before self-employment tax. It does not post to the books.",
  };
}

export function projectAnnual(ytdCents, dayOfYear, daysInYear) {
  if (dayOfYear <= 0 || daysInYear <= 0) return { method: "not_started", projectedCents: null };
  if (dayOfYear >= daysInYear) return { method: "full_year", projectedCents: ytdCents, daysElapsed: daysInYear, daysInYear };
  return {
    method: "annualized",
    projectedCents: Math.round((ytdCents * daysInYear) / dayOfYear),
    daysElapsed: dayOfYear,
    daysInYear,
  };
}

export function splitQuarters(totalCents) {
  const dollars = Math.round(totalCents / 100);
  const base = Math.floor(dollars / 4);
  const extra = dollars - base * 4;
  return [0, 1, 2, 3].map((index) => (base + (index === 3 ? extra : 0)) * 100);
}
