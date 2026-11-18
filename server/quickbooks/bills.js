import { pullOfficialQuery } from "./api.js";

export function pullBills(ctx) {
  return pullOfficialQuery(ctx, "Bill", "select * from Bill STARTPOSITION 1 MAXRESULTS 1000");
}
