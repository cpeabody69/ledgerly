// Tax year 2026 planning figures. Amounts are cents.
// Ordinary brackets and the standard deduction are the 2026 tables in
// Rev. Proc. 2025-32, section 4.01 and section 4.14.
// The self-employment rates are IRC sections 1401 and 1402. The wage base is
// the 2026 Social Security contribution base, 184500 dollars.
// This module does not file a return and does not claim official approval.

export const RULES_VERSION = "2026.1";
export const RULES_YEAR = 2026;

export const STANDARD_DEDUCTION = {
  single: 1_610_000,
  married_joint: 3_220_000,
  married_separate: 1_610_000,
  head: 2_415_000,
};

// upTo and floor are cents. baseCents is the published dollar tax, including a half cent where the table has one.
function band(upToDollars, floorDollars, baseDollars, rate) {
  return {
    upTo: upToDollars == null ? null : Math.round(upToDollars * 100),
    floor: Math.round(floorDollars * 100),
    baseCents: Math.round(baseDollars * 100),
    rate,
  };
}

export const ORDINARY_BRACKETS = {
  married_joint: [
    band(24800, 0, 0, 10),
    band(100800, 24800, 2480, 12),
    band(211400, 100800, 11600, 22),
    band(403550, 211400, 35932, 24),
    band(512450, 403550, 82048, 32),
    band(768700, 512450, 116896, 35),
    band(null, 768700, 206583.5, 37),
  ],
  head: [
    band(17700, 0, 0, 10),
    band(67450, 17700, 1770, 12),
    band(105700, 67450, 7740, 22),
    band(201750, 105700, 16155, 24),
    band(256200, 201750, 39207, 32),
    band(640600, 256200, 56631, 35),
    band(null, 640600, 191171, 37),
  ],
  single: [
    band(12400, 0, 0, 10),
    band(50400, 12400, 1240, 12),
    band(105700, 50400, 5800, 22),
    band(201775, 105700, 17966, 24),
    band(256225, 201775, 41024, 32),
    band(640600, 256225, 58448, 35),
    band(null, 640600, 192979.25, 37),
  ],
  married_separate: [
    band(12400, 0, 0, 10),
    band(50400, 12400, 1240, 12),
    band(105700, 50400, 5800, 22),
    band(201775, 105700, 17966, 24),
    band(256225, 201775, 41024, 32),
    band(384350, 256225, 58448, 35),
    band(null, 384350, 103291.75, 37),
  ],
};

// Rev. Proc. 2025-32 section 4.26. Above this income the wage and property limits apply, and this planner stops.
export const QBI_THRESHOLD = {
  married_joint: 40_350_000,
  married_separate: 20_175_000,
  single: 20_175_000,
  head: 20_175_000,
};

export const SELF_EMPLOYMENT = {
  factorBps: 9235,
  socialSecurityRateBps: 1240,
  medicareRateBps: 290,
  wageBase: 18_450_000,
  minimumNetEarnings: 40_000,
};

export const ADDITIONAL_MEDICARE = {
  rateBps: 90,
  threshold: {
    married_joint: 25_000_000,
    married_separate: 12_500_000,
    single: 20_000_000,
    head: 20_000_000,
  },
};

// Planning caps. The IRA figure follows Notice 2025-67. The SEP percent is the
// common 20 percent of net-earnings shortcut, not a circular 25 percent computation.
export const RETIREMENT = {
  iraLimit: 750_000,
  sepRateBps: 2000,
};

// Rev. Proc. 2025-32 section 4.24. A scenario will not deduct more than this.
export const SECTION_179_LIMIT = 256_000_000;

export const FILING_STATUSES = ["single", "married_joint", "married_separate", "head"];

export function rulesForYear(year) {
  if (Number(year) !== RULES_YEAR) return null;
  return {
    year: RULES_YEAR,
    version: RULES_VERSION,
    standardDeduction: STANDARD_DEDUCTION,
    brackets: ORDINARY_BRACKETS,
    qbiThreshold: QBI_THRESHOLD,
    selfEmployment: SELF_EMPLOYMENT,
    additionalMedicare: ADDITIONAL_MEDICARE,
    retirement: RETIREMENT,
    section179Limit: SECTION_179_LIMIT,
  };
}
