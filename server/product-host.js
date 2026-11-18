// Host settings for Avenue Pro. Cookies stay on the exact host.
// A Domain attribute would send them to Avenue Tax as well.

export function publicOrigin(value = process.env.AVENUE_PRO_PUBLIC_URL || "") {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" && url.protocol !== "http:") return "";
    if (url.username || url.password || url.pathname !== "/" && url.pathname !== "") return "";
    return url.origin;
  } catch {
    return "";
  }
}

export function cookieAttributes(env = process.env) {
  const secure = env.NODE_ENV === "production" ? "; Secure" : "";
  return `HttpOnly; SameSite=Lax; Path=/${secure}`;
}

export function productDescription(env = process.env) {
  return {
    product: "Avenue Pro",
    company: "Avenue Software",
    publicOrigin: publicOrigin(env.AVENUE_PRO_PUBLIC_URL),
    filesReturns: false,
    transmits: false,
    livePayments: false,
    cookieScope: "host",
  };
}

export function applyCors(req, res) {
  const origin = String(req.headers.origin || "");
  const host = String(req.headers.host || "");
  let allowed = "";
  try {
    const url = new URL(origin);
    if (origin && url.host === host) allowed = url.origin;
  } catch {
    allowed = "";
  }
  res.setHeader("vary", "Origin");
  if (!allowed) return;
  res.setHeader("access-control-allow-origin", allowed);
  res.setHeader("access-control-allow-credentials", "true");
  res.setHeader("access-control-allow-headers", "content-type");
  res.setHeader("access-control-allow-methods", "GET, POST, PATCH, DELETE");
}
