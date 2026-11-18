import { pullOfficialQuery } from "./api.js";

export function pullJournalEntries(ctx) {
  return pullOfficialQuery(ctx, "JournalEntry", "select * from JournalEntry STARTPOSITION 1 MAXRESULTS 1000");
}
