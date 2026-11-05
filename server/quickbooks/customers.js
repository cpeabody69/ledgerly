import { pullOfficialQuery } from "./api.js";

export function pullCustomers(ctx) {
  return pullOfficialQuery(ctx, "Customer", "select * from Customer STARTPOSITION 1 MAXRESULTS 1000");
}
