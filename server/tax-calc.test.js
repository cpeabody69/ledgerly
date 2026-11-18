import assert from "node:assert/strict";
import test from "node:test";
import { ordinaryTaxCents, planSoleProp, projectAnnual, selfEmploymentTax } from "./tax-calc.js";

test("the 2026 single table matches the published bracket math", () => {
  assert.equal(ordinaryTaxCents("single", 1_240_000), 124_000);
  assert.equal(ordinaryTaxCents("single", 2_000_000), 215_200);
  assert.equal(ordinaryTaxCents("married_joint", 0), 0);
});

test("self-employment tax on 10000 dollars rounds to the nearest dollar", () => {
  const tax = selfEmploymentTax(1_000_000, 0);
  assert.equal(tax.netEarningsCents, 923_500);
  assert.equal(tax.taxCents, 141_300);
  assert.equal(tax.deductionCents, 70_700);
});

test("a sole proprietor estimate uses self-employment tax, the standard deduction, and the 20 percent deduction", () => {
  const plan = planSoleProp({
    taxYear: 2026,
    entityType: "sole_proprietor",
    filingStatus: "single",
    scheduleCProfitCents: 8_000_000,
    otherWagesCents: 0,
    socialSecurityWagesCents: 0,
  });
  assert.equal(plan.status, "calculated");
  assert.equal(plan.filesReturn, false);
  assert.equal(plan.transmits, false);
  assert.equal(plan.selfEmploymentTaxCents, 1_130_400);
  assert.equal(plan.halfSelfEmploymentCents, 565_200);
  assert.equal(plan.qbiDeductionCents, 1_165_000);
  assert.equal(plan.incomeTaxCents, 534_400);
  assert.equal(plan.totalCents, 1_664_800);
  assert.equal(plan.rulesVersion, "2026.1");
});

test("missing inputs and unsupported entities do not produce an individual estimate", () => {
  const missing = planSoleProp({
    taxYear: 2026,
    entityType: "sole_proprietor",
    filingStatus: "single",
    scheduleCProfitCents: 8_000_000,
  });
  assert.equal(missing.status, "missing");
  assert.equal(missing.totalCents, null);
  const corporation = planSoleProp({
    taxYear: 2026,
    entityType: "corporation",
    filingStatus: "single",
    scheduleCProfitCents: 8_000_000,
    otherWagesCents: 0,
  });
  const partnership = planSoleProp({
    taxYear: 2026,
    entityType: "partnership",
    filingStatus: "single",
    scheduleCProfitCents: 8_000_000,
    otherWagesCents: 0,
  });
  assert.equal(corporation.status, "unsupported");
  assert.equal(partnership.status, "unsupported");
  assert.equal(corporation.totalCents, null);
  assert.match(corporation.limitations.join(" "), /not applied to a corporation or a partnership/);
  assert.equal(planSoleProp({ taxYear: 2025, entityType: "sole_proprietor", filingStatus: "single", otherWagesCents: 0 }).status, "no_rules");
});

test("a retirement deduction does not change self-employment tax, and a year that has not finished is annualized", () => {
  const base = planSoleProp({
    taxYear: 2026,
    entityType: "sole_proprietor",
    filingStatus: "single",
    scheduleCProfitCents: 8_000_000,
    otherWagesCents: 0,
    socialSecurityWagesCents: 0,
  });
  const withRetirement = planSoleProp({
    taxYear: 2026,
    entityType: "sole_proprietor",
    filingStatus: "single",
    scheduleCProfitCents: 8_000_000,
    otherWagesCents: 0,
    socialSecurityWagesCents: 0,
    retirementDeductionCents: 500_000,
  });
  assert.equal(withRetirement.selfEmploymentTaxCents, base.selfEmploymentTaxCents);
  assert.equal(withRetirement.incomeTaxCents < base.incomeTaxCents, true);
  const projected = projectAnnual(60_000, 321, 365);
  assert.equal(projected.method, "annualized");
  assert.equal(projected.projectedCents, Math.round((60_000 * 365) / 321));
  assert.equal(projectAnnual(60_000, 365, 365).method, "full_year");
});
