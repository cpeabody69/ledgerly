import { pullOfficialQuery } from "./api.js";

export function pullAccounts(ctx) {
  return pullOfficialQuery(ctx, "Account", "select * from Account STARTPOSITION 1 MAXRESULTS 1000");
}
