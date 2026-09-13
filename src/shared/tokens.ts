const encoder = new TextEncoder();
const base64url = (data: Uint8Array | string) => {
  const bytes = typeof data === "string" ? encoder.encode(data) : data;
  return Buffer.from(bytes).toString("base64url");
};

async function signature(value: string, secret: string) {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return base64url(new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(value))));
}

export async function createAccessToken(payload: { sub: string; role: string }, secret: string, ttl: number) {
  const header = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = base64url(JSON.stringify({ ...payload, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + ttl }));
  const unsigned = `${header}.${body}`;
  return `${unsigned}.${await signature(unsigned, secret)}`;
}

export async function verifyAccessToken(token: string, secret: string) {
  const [header, body, supplied, extra] = token.split(".");
  if (!header || !body || !supplied || extra || await signature(`${header}.${body}`, secret) !== supplied)
    throw new Error("invalid token");
  const payload = JSON.parse(Buffer.from(body, "base64url").toString()) as { sub: string; role: "requester" | "manager"; exp: number };
  if (!payload.sub || !["requester", "manager"].includes(payload.role) || payload.exp <= Date.now() / 1000) throw new Error("expired token");
  return payload;
}

export async function tokenHash(token: string) {
  return Buffer.from(await crypto.subtle.digest("SHA-256", encoder.encode(token))).toString("hex");
}
