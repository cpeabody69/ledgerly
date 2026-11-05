import { pullOfficialQuery } from "./api.js";

export function pullVendors(ctx) {
  return pullOfficialQuery(ctx, "Vendor", "select * from Vendor STARTPOSITION 1 MAXRESULTS 1000");
}
