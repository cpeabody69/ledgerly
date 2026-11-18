import { MINOR_VERSION, SANDBOX_API } from "./config.js";
import { intuitGet } from "./api.js";
import { storeQuickBooksReport } from "./mirror.js";

function period() {
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  return { start: `${today.slice(0, 4)}-01-01`, end: today };
}

async function pullReport(ctx, name) {
  const dates = period();
  const url = new URL(`${SANDBOX_API}/v3/company/${ctx.realmId}/reports/${name}`);
  url.searchParams.set("minorversion", MINOR_VERSION);
  url.searchParams.set("start_date", dates.start);
  url.searchParams.set("end_date", dates.end);
  const result = await intuitGet(ctx, url);
  if (!result.ok) return { ok: false, entity: name, importedIds: [], unchangedIds: [], conflictIds: [], rejectedIds: [], error: result.error };
  const stored = storeQuickBooksReport(ctx.db, ctx, name, {
    ...result.payload,
    Header: { ...(result.payload.Header || {}), StartPeriod: dates.start, EndPeriod: dates.end, ReportName: name },
  });
  return {
    ok: true,
    entity: name,
    importedIds: stored.imported ? [name] : [],
    unchangedIds: stored.unchanged ? [name] : [],
    conflictIds: [],
    rejectedIds: [],
    error: "",
    unchanged: Boolean(stored.unchanged),
  };
}

export function pullProfitAndLoss(ctx) {
  return pullReport(ctx, "ProfitAndLoss");
}

export function pullBalanceSheet(ctx) {
  return pullReport(ctx, "BalanceSheet");
}
