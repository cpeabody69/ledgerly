import { pullOfficialQuery } from "./api.js";

export function pullInvoices(ctx) {
  return pullOfficialQuery(ctx, "Invoice", "select * from Invoice STARTPOSITION 1 MAXRESULTS 1000");
}
