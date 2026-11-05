import { pullOfficialQuery } from "./api.js";

export function pullPayments(ctx) {
  return pullOfficialQuery(ctx, "Payment", "select * from Payment STARTPOSITION 1 MAXRESULTS 1000");
}
