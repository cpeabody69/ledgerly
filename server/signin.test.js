import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { firms } from "./accounts.js";
import { start } from "./app.js";
import { verifyPassword } from "./db.js";
import { DEMO_OWNER } from "./demo.js";

function cookieJar() {
  const cookies = new Map();
  return {
    async fetch(url, options = {}) {
      const headers = new Headers(options.headers || {});
      if (cookies.size) headers.set("cookie", [...cookies].map(([key, value]) => `${key}=${value}`).join("; "));
      const response = await fetch(url, { ...options, headers });
      const setCookies = typeof response.headers.getSetCookie === "function" ? response.headers.getSetCookie() : [];
      for (const line of setCookies) {
        const [pair] = line.split(";");
        const eq = pair.indexOf("=");
        const key = pair.slice(0, eq).trim();
        const value = pair.slice(eq + 1);
        if (/Max-Age=0/i.test(line)) cookies.delete(key);
        else cookies.set(key, value);
      }
      return response;
    },
  };
}

async function withServer(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), "ledgerly-signin-"));
  const dbPath = path.join(dir, "test.sqlite");
  const running = await start(dbPath, 0);
  const base = `http://127.0.0.1:${running.port}`;
  try {
    await fn(base, dbPath);
  } finally {
    await new Promise((resolve, reject) => running.server.close((error) => (error ? reject(error) : resolve())));
    await rm(dir, { recursive: true, force: true });
  }
}

function samplePeople() {
  const people = [];
  for (const firm of Object.values(firms)) {
    people.push({ ...firm.owner, role: "owner", firm: firm.name });
    for (const member of firm.members || []) people.push({ ...member, firm: firm.name });
    if (firm.portal) people.push({ ...firm.portal, role: "client", firm: firm.name });
  }
  people.push({ ...DEMO_OWNER, role: "owner", firm: "Avenue Demo (fictional)" });
  return people;
}

async function signIn(jar, base, account) {
  const response = await jar.fetch(`${base}/api/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: account.email, password: account.password }),
  });
  const body = await response.json();
  return { response, body };
}

async function rejected(base, email, password) {
  const jar = cookieJar();
  const { response, body } = await signIn(jar, base, { email, password });
  assert.equal(response.status, 401);
  assert.equal(body.user, undefined);
  assert.equal(JSON.stringify(body).includes(password), false);
  const follow = await jar.fetch(`${base}/api/session`);
  assert.equal(follow.status, 401);
}

test("two people in one firm sign in separately, and a password does not open another person or firm", async () => {
  const people = samplePeople();
  const passwords = people.map((person) => person.password);
  assert.equal(new Set(passwords).size, passwords.length);
  assert.equal(passwords.includes("ledgerly-northstar"), false);
  assert.equal(passwords.includes("ledgerly-harbor"), false);
  assert.equal(passwords.includes("ledgerly-client"), false);
  assert.equal(passwords.includes("ledgerly-staff"), false);
  assert.equal(DEMO_OWNER.password, "ledgerly-demo");
  assert.equal(people.filter((person) => person.password === DEMO_OWNER.password).length, 1);

  await withServer(async (base, dbPath) => {
    const samAccount = firms.northstar.members.find((member) => member.role === "staff" && member.email === "sam@northstarcreative.co");
    const morganAccount = firms.northstar.members.find((member) => member.role === "manager");
    const rileyAccount = firms.northstar.members.find((member) => member.email === "riley@northstarcreative.co");

    const oliviaJar = cookieJar();
    const samJar = cookieJar();
    const olivia = await signIn(oliviaJar, base, firms.northstar.owner);
    const sam = await signIn(samJar, base, samAccount);
    assert.equal(olivia.response.status, 200);
    assert.equal(sam.response.status, 200);
    assert.equal(olivia.body.user.email, firms.northstar.owner.email);
    assert.equal(olivia.body.user.name, "Olivia Martin");
    assert.equal(olivia.body.user.role, "owner");
    assert.equal(sam.body.user.email, samAccount.email);
    assert.equal(sam.body.user.name, "Sam Lee");
    assert.equal(sam.body.user.role, "staff");
    assert.notEqual(olivia.body.user.id, sam.body.user.id);
    assert.equal(olivia.body.firm.name, "Northstar");
    assert.equal(sam.body.firm.name, "Northstar");
    assert.equal(olivia.body.firm.id, sam.body.firm.id);
    assert.equal(JSON.stringify(olivia.body).includes(firms.northstar.owner.password), false);
    assert.equal(JSON.stringify(sam.body).includes(samAccount.password), false);

    const oliviaStill = await (await oliviaJar.fetch(`${base}/api/session`)).json();
    const samStill = await (await samJar.fetch(`${base}/api/session`)).json();
    assert.equal(oliviaStill.user.email, firms.northstar.owner.email);
    assert.equal(samStill.user.email, samAccount.email);
    assert.deepEqual(oliviaStill.members.map((member) => member.role).sort(), ["manager", "owner", "staff", "staff"]);

    const morgan = await signIn(cookieJar(), base, morganAccount);
    assert.equal(morgan.response.status, 200);
    assert.equal(morgan.body.user.email, morganAccount.email);
    assert.equal(morgan.body.user.role, "manager");
    assert.equal(morgan.body.firm.name, "Northstar");
    assert.notEqual(morgan.body.user.id, olivia.body.user.id);

    const riley = await signIn(cookieJar(), base, rileyAccount);
    assert.equal(riley.response.status, 200);
    assert.equal(riley.body.user.role, "staff");
    assert.notEqual(riley.body.user.id, sam.body.user.id);

    const casey = await signIn(cookieJar(), base, firms.northstar.portal);
    assert.equal(casey.response.status, 200);
    assert.equal(casey.body.portal, true);
    assert.equal(casey.body.user.email, firms.northstar.portal.email);
    assert.equal(casey.body.user.role, "client");
    assert.equal(casey.body.firm.name, "Northstar");
    assert.equal(casey.body.client.name, "Brightline Labs");
    const caseyBooks = await cookieJar();
    await signIn(caseyBooks, base, firms.northstar.portal);
    const haven = olivia.body.clients.find((client) => client.name === "Haven Coffee Roasters");
    assert.equal((await caseyBooks.fetch(`${base}/api/ledger`)).status, 404);
    assert.equal((await caseyBooks.fetch(`${base}/api/clients/${haven.id}`)).status, 404);

    const jordan = await signIn(cookieJar(), base, firms.harbor.owner);
    assert.equal(jordan.response.status, 200);
    assert.equal(jordan.body.user.email, firms.harbor.owner.email);
    assert.equal(jordan.body.firm.name, "Harbor Street Advisors");
    assert.notEqual(jordan.body.firm.id, olivia.body.firm.id);
    assert.equal(jordan.body.clients.some((client) => client.id === haven.id), false);
    const jordanJar = cookieJar();
    await signIn(jordanJar, base, firms.harbor.owner);
    const hiddenNorthstar = await jordanJar.fetch(`${base}/api/clients/${haven.id}`);
    assert.equal(hiddenNorthstar.status, 404);
    const hiddenHarbor = await samJar.fetch(`${base}/api/clients/${jordan.body.client.id}`);
    assert.equal(hiddenHarbor.status, 404);
    assert.equal(JSON.stringify(await hiddenHarbor.json()).includes("Cedar"), false);

    const rowan = await signIn(cookieJar(), base, firms.harbor.portal);
    assert.equal(rowan.response.status, 200);
    assert.equal(rowan.body.user.role, "client");
    assert.equal(rowan.body.firm.name, "Harbor Street Advisors");
    assert.equal(rowan.body.client.name, "Cedar & Pine Goods");
    assert.notEqual(rowan.body.user.id, casey.body.user.id);

    const avery = await signIn(cookieJar(), base, DEMO_OWNER);
    assert.equal(avery.response.status, 200);
    assert.equal(avery.body.user.email, DEMO_OWNER.email);
    assert.equal(avery.body.firm.name, "Avenue Demo (fictional)");
    assert.equal(avery.body.firm.demo, true);
    assert.equal(avery.body.clients.some((client) => client.name === "Northstar Creative" || client.name === "Cedar & Pine Goods"), false);
    assert.equal(avery.body.members.some((member) => member.email === firms.northstar.owner.email || member.email === firms.harbor.owner.email), false);

    await rejected(base, samAccount.email, firms.northstar.owner.password);
    await rejected(base, firms.northstar.owner.email, samAccount.password);
    await rejected(base, samAccount.email, morganAccount.password);
    await rejected(base, morganAccount.email, rileyAccount.password);
    await rejected(base, firms.harbor.owner.email, samAccount.password);
    await rejected(base, firms.harbor.owner.email, firms.northstar.owner.password);
    await rejected(base, firms.northstar.owner.email, firms.harbor.owner.password);
    await rejected(base, firms.harbor.portal.email, firms.northstar.portal.password);
    await rejected(base, firms.northstar.portal.email, firms.harbor.portal.password);
    await rejected(base, firms.northstar.owner.email, DEMO_OWNER.password);
    await rejected(base, firms.harbor.owner.email, DEMO_OWNER.password);
    await rejected(base, DEMO_OWNER.email, firms.northstar.owner.password);
    await rejected(base, DEMO_OWNER.email, firms.harbor.owner.password);
    await rejected(base, firms.northstar.owner.email, "ledgerly-northstar");
    await rejected(base, firms.harbor.owner.email, "ledgerly-harbor");
    await rejected(base, firms.northstar.portal.email, "ledgerly-client");
    await rejected(base, firms.harbor.portal.email, "ledgerly-client");
    await rejected(base, samAccount.email, "ledgerly-staff");

    const db = new DatabaseSync(dbPath);
    const firmColumns = db.prepare("PRAGMA table_info(firms)").all().map((column) => column.name);
    assert.equal(firmColumns.includes("password"), false);
    assert.equal(firmColumns.includes("password_hash"), false);
    const stored = [
      ...db.prepare("SELECT email, password_hash FROM users").all(),
      ...db.prepare("SELECT email, password_hash FROM client_users").all(),
    ];
    assert.equal(stored.length >= people.length, true);
    for (const row of stored) {
      const owner = people.find((person) => person.email === row.email);
      assert.ok(owner, row.email);
      assert.equal(verifyPassword(owner.password, row.password_hash), true);
      for (const other of people) {
        if (other.email === row.email) continue;
        assert.equal(verifyPassword(other.password, row.password_hash), false, `${other.email} password opened ${row.email}`);
      }
    }
    db.close();
  });
});
