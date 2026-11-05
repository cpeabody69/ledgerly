import { pullOfficialQuery } from "./api.js";

export function pullTransactions(ctx) {
  return pullOfficialQuery(ctx, "Purchase", "select * from Purchase STARTPOSITION 1 MAXRESULTS 1000");
}
