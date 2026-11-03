import path from "node:path";
import { fileURLToPath } from "node:url";
import { start } from "./app.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dbPath = process.env.LEDGERLY_DB || path.join(root, "data", "ledgerly.sqlite");
const port = Number(process.env.PORT || 8787);
const staticDir = process.env.NODE_ENV === "production" ? path.join(root, "dist") : null;

const running = await start(dbPath, port, { staticDir });
console.log(`Ledgerly listening on http://127.0.0.1:${running.port}`);
