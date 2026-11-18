import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { start } from "./app.js";
import { cookieAttributes } from "./product-host.js";

async function withServer(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), "ledgerly-product-host-"));
  const running = await start(path.join(dir, "test.sqlite"), 0);
  const base = `http://127.0.0.1:${running.port}`;
  try {
    await fn(base);
  } finally {
    await new Promise((resolve, reject) => running.server.close((error) => (error ? reject(error) : resolve())));
    await rm(dir, { recursive: true, force: true });
  }
}

test("the product host keeps cookies on one host and refuses the tax origin", async () => {
  assert.equal(cookieAttributes().includes("Domain="), false);
  assert.match(cookieAttributes({ NODE_ENV: "production" }), /Secure/);
  assert.equal(cookieAttributes({ NODE_ENV: "production" }).includes("Domain="), false);

  await withServer(async (base) => {
    const described = await fetch(`${base}/api/product`);
    const product = await described.json();
    assert.equal(product.product, "Avenue Pro");
    assert.equal(product.company, "Avenue Software");
    assert.equal(product.filesReturns, false);
    assert.equal(product.transmits, false);
    assert.equal(product.livePayments, false);
    assert.equal(product.cookieScope, "host");
    assert.equal(JSON.stringify(product).includes("$"), false);

    const foreign = await fetch(`${base}/api/session`, {
      method: "POST",
      headers: {
        origin: "https://tax.avenuesoftware.app",
        "content-type": "application/json",
      },
      body: JSON.stringify({ email: "person@example.com", password: "not-a-password" }),
    });
    assert.equal(foreign.status, 403);
    assert.equal(foreign.headers.get("access-control-allow-origin"), null);

    const origin = new URL(base).origin;
    const preflight = await fetch(`${base}/api/product`, { method: "OPTIONS", headers: { origin } });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get("access-control-allow-origin"), origin);

    const demo = await fetch(`${base}/api/demo/enter`, { method: "POST", headers: { origin } });
    const body = await demo.json();
    assert.equal(demo.status, 200, body.error);
    assert.match(body.firm.name, /fictional/i);
    const cookie = demo.headers.get("set-cookie") || "";
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Lax/);
    assert.equal(/Domain=/i.test(cookie), false);
  });
});
