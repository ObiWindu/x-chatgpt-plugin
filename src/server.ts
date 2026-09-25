import "dotenv/config";
import express, { Request, Response, NextFunction } from "express";
import cookieParser from "cookie-parser";
import helmet from "helmet";
import Database from "better-sqlite3";
import crypto from "node:crypto";
import { z } from "zod";
import { SignJWT, jwtVerify } from "jose";

const env = z.object({
  PORT: z.coerce.number().default(3000),
  PUBLIC_BASE_URL: z.string().url(),
  DATABASE_PATH: z.string().default("./data/app.db"),
  X_CLIENT_ID: z.string().min(1),
  X_CLIENT_SECRET: z.string().min(1),
  X_REDIRECT_URI: z.string().url(),
  CHATGPT_CLIENT_ID: z.string().min(1),
  CHATGPT_CLIENT_SECRET: z.string().min(1),
  CHATGPT_ALLOWED_REDIRECT_URIS: z.string().min(1),
  TOKEN_ENCRYPTION_KEY_B64: z.string().min(1),
  COOKIE_SECURE: z.string().default("true")
}).parse(process.env);

const encryptionKey = Buffer.from(env.TOKEN_ENCRYPTION_KEY_B64, "base64");
if (encryptionKey.length !== 32) throw new Error("TOKEN_ENCRYPTION_KEY_B64 must decode to 32 bytes");

const allowedRedirectUris = new Set(env.CHATGPT_ALLOWED_REDIRECT_URIS.split(",").map(x => x.trim()).filter(Boolean));
const app = express();
app.use(helmet());
app.use(express.json({ limit: "16kb" }));
app.use(cookieParser());

const db = new Database(env.DATABASE_PATH);
db.pragma("journal_mode = WAL");
db.exec(`
CREATE TABLE IF NOT EXISTS users (
 id TEXT PRIMARY KEY, x_user_id TEXT UNIQUE NOT NULL, x_username TEXT, x_name TEXT,
 access_token_enc TEXT NOT NULL, refresh_token_enc TEXT, access_expires_at INTEGER,
 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS oauth_requests (
 state TEXT PRIMARY KEY, client_id TEXT NOT NULL, redirect_uri TEXT NOT NULL,
 code_challenge TEXT NOT NULL, code_challenge_method TEXT NOT NULL,
 created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS auth_codes (
 code_hash TEXT PRIMARY KEY, client_id TEXT NOT NULL, redirect_uri TEXT NOT NULL,
 user_id TEXT NOT NULL, code_challenge TEXT NOT NULL, code_challenge_method TEXT NOT NULL,
 expires_at INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0
);
`);

const now = () => Math.floor(Date.now() / 1000);
const random = (n = 32) => crypto.randomBytes(n).toString("base64url");
const hash = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

function encrypt(value: string) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", encryptionKey, iv);
  const data = Buffer.concat([c.update(value, "utf8"), c.final()]);
  return `${iv.toString("base64url")}.${c.getAuthTag().toString("base64url")}.${data.toString("base64url")}`;
}
function decrypt(value: string) {
  const [iv, tag, data] = value.split(".");
  const d = crypto.createDecipheriv("aes-256-gcm", encryptionKey, Buffer.from(iv, "base64url"));
  d.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([d.update(Buffer.from(data, "base64url")), d.final()]).toString("utf8");
}

const jwtKey = crypto.createHash("sha256").update(env.CHATGPT_CLIENT_SECRET).digest();
async function serviceToken(userId: string) {
  return new SignJWT({ sub: userId, aud: "x-chatgpt-action" })
    .setProtectedHeader({ alg: "HS256" }).setIssuedAt().setExpirationTime("1h").sign(jwtKey);
}
async function verifyServiceToken(token: string) {
  const { payload } = await jwtVerify(token, jwtKey, { audience: "x-chatgpt-action" });
  if (!payload.sub) throw new Error("missing sub");
  return payload.sub;
}

async function xToken(params: URLSearchParams) {
  const basic = Buffer.from(`${env.X_CLIENT_ID}:${env.X_CLIENT_SECRET}`).toString("base64");
  const r = await fetch("https://api.x.com/2/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: `Basic ${basic}` },
    body: params
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`X OAuth ${r.status}: ${text}`);
  return JSON.parse(text) as { access_token: string; refresh_token?: string; expires_in?: number };
}

async function xApi(path: string, init: RequestInit, token: string) {
  const r = await fetch(`https://api.x.com${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(init.headers || {}) }
  });
  const text = await r.text();
  let body: any; try { body = JSON.parse(text); } catch { body = { raw: text }; }
  if (!r.ok) { const e: any = new Error(`X API ${r.status}`); e.status = r.status; e.body = body; throw e; }
  return body;
}

function browserUser(req: Request) {
  const id = req.cookies.x_session;
  return id ? db.prepare("SELECT * FROM users WHERE id=?").get(id) as any : null;
}

app.get("/health", (_req, res) => res.json({ ok: true }));

// Start the X user OAuth flow.
app.get("/connect/x", (req, res) => {
  const returnTo = typeof req.query.return_to === "string" ? req.query.return_to : "/connected";
  const state = random(24);
  const url = new URL("https://twitter.com/i/oauth2/authorize");
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", env.X_CLIENT_ID);
  url.searchParams.set("redirect_uri", env.X_REDIRECT_URI);
  url.searchParams.set("scope", "tweet.read tweet.write users.read offline.access");
  url.searchParams.set("state", state);
  // PKCE verifier is the state itself for this connection transaction.
  url.searchParams.set("code_challenge", crypto.createHash("sha256").update(state).digest("base64url"));
  url.searchParams.set("code_challenge_method", "S256");
  res.cookie("x_connect_state", JSON.stringify({ state, returnTo }), {
    httpOnly: true, secure: env.COOKIE_SECURE === "true", sameSite: "lax", maxAge: 600000
  });
  res.redirect(url.toString());
});

app.get("/auth/x/callback", async (req, res) => {
  try {
    const c = JSON.parse(req.cookies.x_connect_state || "{}");
    if (!c.state || c.state !== req.query.state) return res.status(400).send("Invalid OAuth state");
    if (typeof req.query.code !== "string") return res.status(400).send("Missing code");

    const tokens = await xToken(new URLSearchParams({
      grant_type: "authorization_code",
      code: req.query.code,
      redirect_uri: env.X_REDIRECT_URI,
      code_verifier: c.state
    }));
    const me = await xApi("/2/users/me", { method: "GET" }, tokens.access_token);
    const x = me.data;
    const existing = db.prepare("SELECT id FROM users WHERE x_user_id=?").get(x.id) as any;
    const userId = existing?.id || crypto.randomUUID();
    const t = now();

    db.prepare(`
      INSERT INTO users VALUES (?,?,?,?,?,?,?,?,?)
      ON CONFLICT(x_user_id) DO UPDATE SET
      x_username=excluded.x_username, x_name=excluded.x_name,
      access_token_enc=excluded.access_token_enc, refresh_token_enc=excluded.refresh_token_enc,
      access_expires_at=excluded.access_expires_at, updated_at=excluded.updated_at
    `).run(
      userId, x.id, x.username || null, x.name || null, encrypt(tokens.access_token),
      tokens.refresh_token ? encrypt(tokens.refresh_token) : null,
      tokens.expires_in ? t + tokens.expires_in : null, t, t
    );

    res.cookie("x_session", userId, {
      httpOnly: true, secure: env.COOKIE_SECURE === "true", sameSite: "lax", maxAge: 7 * 86400000
    });
    res.clearCookie("x_connect_state");
    res.redirect(c.returnTo || "/connected");
  } catch (e) {
    console.error(e);
    res.status(500).send("X authorization failed");
  }
});

app.get("/connected", (req, res) => {
  const u = browserUser(req);
  if (!u) return res.redirect("/connect/x");
  res.type("html").send(`<h1>X account connected</h1><p>Connected as @${String(u.x_username || "")}</p>`);
});

// OAuth server used by ChatGPT.
app.get("/oauth/authorize", (req, res) => {
  const clientId = String(req.query.client_id || "");
  const redirectUri = String(req.query.redirect_uri || "");
  const state = String(req.query.state || "");
  const challenge = String(req.query.code_challenge || "");
  const method = String(req.query.code_challenge_method || "");

  if (clientId !== env.CHATGPT_CLIENT_ID) return res.status(400).send("Unknown client");
  if (!allowedRedirectUris.has(redirectUri)) return res.status(400).send("Unapproved redirect URI");
  if (!state || !challenge || method !== "S256") return res.status(400).send("PKCE S256 required");

  const user = browserUser(req);
  if (!user) {
    const continueUrl = new URL("/oauth/authorize", env.PUBLIC_BASE_URL);
    for (const [k, v] of Object.entries(req.query)) continueUrl.searchParams.set(k, String(v));
    return res.redirect(`/connect/x?return_to=${encodeURIComponent(continueUrl.toString())}`);
  }

  db.prepare(`
    INSERT INTO oauth_requests VALUES (?,?,?,?,?,?)
  `).run(state, clientId, redirectUri, challenge, method, now());

  res.type("html").send(`
<!doctype html><html><body style="font-family:system-ui;max-width:700px;margin:60px auto">
<h1>Authorize X Publisher</h1>
<p>ChatGPT is requesting permission to publish to <b>@${String(user.x_username || "")}</b>.</p>
<form method="post" action="/oauth/approve">
<input type="hidden" name="state" value="${state}">
<button>Allow ChatGPT to post</button>
</form></body></html>`);
});

app.post("/oauth/approve", (req, res) => {
  const state = String(req.body.state || "");
  const row = db.prepare("SELECT * FROM oauth_requests WHERE state=?").get(state) as any;
  const user = browserUser(req);
  if (!row || !user || row.created_at < now() - 600) return res.status(400).send("Authorization expired");

  const code = random(32);
  db.prepare(`
    INSERT INTO auth_codes VALUES (?,?,?,?,?,?,?,0)
  `).run(hash(code), row.client_id, row.redirect_uri, user.id, row.code_challenge, row.code_challenge_method, now() + 300);

  db.prepare("DELETE FROM oauth_requests WHERE state=?").run(state);
  const redirect = new URL(row.redirect_uri);
  redirect.searchParams.set("code", code);
  redirect.searchParams.set("state", state);
  res.redirect(redirect.toString());
});

app.post("/oauth/token", async (req, res) => {
  const clientId = String(req.body.client_id || "");
  const secret = String(req.body.client_secret || "");
  if (clientId !== env.CHATGPT_CLIENT_ID || secret !== env.CHATGPT_CLIENT_SECRET)
    return res.status(401).json({ error: "invalid_client" });

  const code = String(req.body.code || "");
  const redirectUri = String(req.body.redirect_uri || "");
  const verifier = String(req.body.code_verifier || "");
  const row = db.prepare("SELECT * FROM auth_codes WHERE code_hash=?").get(hash(code)) as any;

  if (!row || row.used || row.expires_at < now() || row.client_id !== clientId || row.redirect_uri !== redirectUri)
    return res.status(400).json({ error: "invalid_grant" });

  const expected = crypto.createHash("sha256").update(verifier).digest("base64url");
  if (expected !== row.code_challenge) return res.status(400).json({ error: "invalid_grant" });

  db.prepare("UPDATE auth_codes SET used=1 WHERE code_hash=?").run(hash(code));
  res.json({ access_token: await serviceToken(row.user_id), token_type: "Bearer", expires_in: 3600, scope: "x.post" });
});

async function auth(req: Request, res: Response, next: NextFunction) {
  try {
    const h = req.headers.authorization || "";
    if (!h.startsWith("Bearer ")) return res.status(401).json({ error: "unauthorized" });
    (req as any).userId = await verifyServiceToken(h.slice(7));
    next();
  } catch { res.status(401).json({ error: "unauthorized" }); }
}

async function usableXToken(u: any) {
  if (u.access_expires_at && u.access_expires_at > now() + 60) return decrypt(u.access_token_enc);
  if (!u.refresh_token_enc) return decrypt(u.access_token_enc);

  const tokens = await xToken(new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: decrypt(u.refresh_token_enc)
  }));
  const t = now();
  db.prepare(`
    UPDATE users SET access_token_enc=?, refresh_token_enc=?, access_expires_at=?, updated_at=? WHERE id=?
  `).run(
    encrypt(tokens.access_token),
    tokens.refresh_token ? encrypt(tokens.refresh_token) : u.refresh_token_enc,
    tokens.expires_in ? t + tokens.expires_in : null, t, u.id
  );
  return tokens.access_token;
}

app.get("/v1/x/me", auth, (req, res) => {
  const u = db.prepare("SELECT x_user_id,x_username,x_name FROM users WHERE id=?").get((req as any).userId) as any;
  if (!u) return res.status(404).json({ error: "x_account_not_connected" });
  res.json({ id: u.x_user_id, username: u.x_username, name: u.x_name });
});

app.post("/v1/x/posts", auth, async (req, res) => {
  const parsed = z.object({ text: z.string().trim().min(1).max(280) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_request" });

  try {
    const u = db.prepare("SELECT * FROM users WHERE id=?").get((req as any).userId) as any;
    if (!u) return res.status(404).json({ error: "x_account_not_connected" });

    const result = await xApi("/2/tweets", {
      method: "POST",
      body: JSON.stringify({ text: parsed.data.text })
    }, await usableXToken(u));

    res.status(201).json({
      id: result.data?.id,
      text: result.data?.text,
      url: result.data?.id ? `https://x.com/i/web/status/${result.data.id}` : undefined
    });
  } catch (e: any) {
    console.error(e);
    res.status(e.status === 429 ? 429 : 502).json({
      error: e.status === 429 ? "x_rate_limited" : "x_api_error",
      message: e.body || e.message
    });
  }
});

app.get("/openapi.yaml", (_req, res) => {
  res.type("text/yaml").send(`openapi: 3.1.0
info:
  title: X Publisher
  version: 1.0.0
servers:
  - url: ${env.PUBLIC_BASE_URL}
paths:
  /v1/x/me:
    get:
      operationId: getConnectedXAccount
      summary: Get the connected X account
      security:
        - oauth2: [x.post]
      responses:
        '200':
          description: Connected account
          content:
            application/json:
              schema:
                type: object
                properties:
                  id: {type: string}
                  username: {type: string}
                  name: {type: string}
  /v1/x/posts:
    post:
      operationId: createXPost
      summary: Publish a post to X
      security:
        - oauth2: [x.post]
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [text]
              properties:
                text:
                  type: string
                  minLength: 1
                  maxLength: 280
                  description: Exact text to publish.
      responses:
        '201': {description: Post created}
        '400': {description: Invalid request}
        '401': {description: Unauthorized}
        '429': {description: X rate limit exceeded}
        '502': {description: X API error}
components:
  securitySchemes:
    oauth2:
      type: oauth2
      flows:
        authorizationCode:
          authorizationUrl: ${env.PUBLIC_BASE_URL}/oauth/authorize
          tokenUrl: ${env.PUBLIC_BASE_URL}/oauth/token
          scopes:
            x.post: Publish posts to the connected X account
`);
});

app.get("/", (_req, res) => res.type("html").send(`
<h1>X → ChatGPT Publisher</h1>
<p><a href="/connect/x">Connect X</a> · <a href="/openapi.yaml">OpenAPI</a></p>
`));

app.listen(env.PORT, () => console.log(`Listening on ${env.PUBLIC_BASE_URL}`));
