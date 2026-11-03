import { spawn } from "node:child_process";
import process from "node:process";

const api = spawn(process.execPath, ["--experimental-sqlite", "server/index.js"], {
  stdio: "inherit",
  env: { ...process.env, PORT: process.env.PORT || "8787" },
});

const web = spawn(process.execPath, ["node_modules/vite/bin/vite.js", "--host", "127.0.0.1", "--port", process.env.WEB_PORT || "5173"], {
  stdio: "inherit",
});

function shutdown(code = 0) {
  if (!api.killed) api.kill();
  if (!web.killed) web.kill();
  process.exit(code);
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
api.on("exit", (code) => shutdown(code ?? 0));
web.on("exit", (code) => shutdown(code ?? 0));
