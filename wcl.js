// Warcraft Logs API v2 through the PKCE login: no client secret, so it works on a static site.
// Whoever connects logs in with their own Warcraft Logs account; the token stays in their browser.
import { warcraftLogsClientId } from "./firebase-config.js";

const AUTHORIZE_URL = "https://www.warcraftlogs.com/oauth/authorize";
const TOKEN_URL = "https://www.warcraftlogs.com/oauth/token";
const API_URL = "https://www.warcraftlogs.com/api/v2/user";
const TOKEN_KEY = "wclToken";
const PKCE_KEY = "wclPkce";

const redirectUri = () => location.origin + location.pathname;

export const isConfigured = () => !!warcraftLogsClientId && warcraftLogsClientId !== "PASTE_ME";

// ---------- storage (can be unavailable, e.g. private windows) ----------

function readJson(storage, key) {
  try { return JSON.parse(storage.getItem(key) ?? "null"); } catch { return null; }
}
function writeJson(storage, key, value) {
  try { value == null ? storage.removeItem(key) : storage.setItem(key, JSON.stringify(value)); } catch { /* ignore */ }
}

function saveToken(body) {
  writeJson(localStorage, TOKEN_KEY, {
    access: body.access_token,
    refresh: body.refresh_token ?? null,
    expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000,
  });
}

export const isConnected = () => !!readJson(localStorage, TOKEN_KEY);
export const disconnect = () => writeJson(localStorage, TOKEN_KEY, null);

// ---------- login ----------

const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes)))
  .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

// Sends the browser to Warcraft Logs; it comes back to this page with ?code=…&state=…
export async function connect() {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(48)));
  const challenge = b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  const state = b64url(crypto.getRandomValues(new Uint8Array(16)));
  writeJson(sessionStorage, PKCE_KEY, { verifier, state });
  const params = new URLSearchParams({
    client_id: warcraftLogsClientId,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
    redirect_uri: redirectUri(),
    response_type: "code",
  });
  location.assign(`${AUTHORIZE_URL}?${params}`);
}

// Finishes the login if the page was opened by Warcraft Logs' redirect. Returns true if it did.
export async function handleRedirect() {
  const params = new URLSearchParams(location.search);
  const code = params.get("code");
  const error = params.get("error");
  if (!code && !error) return false;
  history.replaceState(null, "", redirectUri()); // drop ?code=… from the address bar
  if (error) throw new Error(params.get("error_description") || error);
  const saved = readJson(sessionStorage, PKCE_KEY);
  writeJson(sessionStorage, PKCE_KEY, null);
  if (!saved || saved.state !== params.get("state")) {
    throw new Error("The Warcraft Logs login couldn't be verified. Please try again.");
  }
  await tokenRequest({
    grant_type: "authorization_code",
    client_id: warcraftLogsClientId,
    code,
    redirect_uri: redirectUri(),
    code_verifier: saved.verifier,
  });
  return true;
}

async function tokenRequest(fields) {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error_description || body.message || `Warcraft Logs login failed (${res.status})`);
  saveToken(body);
}

async function accessToken() {
  const t = readJson(localStorage, TOKEN_KEY);
  if (!t) return null;
  if (t.expiresAt > Date.now() + 60_000) return t.access;
  if (!t.refresh) { disconnect(); return null; }
  try {
    await tokenRequest({ grant_type: "refresh_token", client_id: warcraftLogsClientId, refresh_token: t.refresh });
    return readJson(localStorage, TOKEN_KEY)?.access ?? null;
  } catch {
    disconnect();
    return null;
  }
}

// ---------- API ----------

export class NotConnectedError extends Error {}

async function gql(query, variables = {}) {
  const token = await accessToken();
  if (!token) throw new NotConnectedError("Connect Warcraft Logs first.");
  const res = await fetch(API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ query, variables }),
  });
  if (res.status === 401) {
    disconnect();
    throw new NotConnectedError("The Warcraft Logs login has expired. Connect again.");
  }
  const body = await res.json().catch(() => ({}));
  // Partial errors (e.g. one character not found on Warcraft Logs) still come with usable data.
  if (!body.data) throw new Error(body.errors?.[0]?.message || `Warcraft Logs error (${res.status})`);
  return body.data;
}

// Accepts a full report link (with or without #fight=…) or just the 16-character code.
export function reportCodeFrom(text) {
  const s = String(text ?? "").trim();
  return (s.match(/reports\/(?:a:)?([A-Za-z0-9]{16})/) ?? s.match(/^([A-Za-z0-9]{16})$/))?.[1] ?? null;
}

// Lowercase letters and digits only, so "Twisting Nether", "twisting-nether" and "TwistingNether" match.
const norm = (s) => String(s ?? "").toLocaleLowerCase().replace(/[^\p{L}\p{N}]/gu, "");

// Report codes that show up in the recent reports of at least `minPlayers` of the characters.
export async function recentTeamReportCodes(characters, minPlayers) {
  const vars = {};
  const defs = [];
  const fields = characters.map((c, i) => {
    defs.push(`$n${i}: String`, `$s${i}: String`, `$r${i}: String`);
    Object.assign(vars, { [`n${i}`]: c.name, [`s${i}`]: c.realmSlug, [`r${i}`]: c.region });
    return `c${i}: characterData { character(name: $n${i}, serverSlug: $s${i}, serverRegion: $r${i}) {
      recentReports(limit: 15) { data { code startTime } } } }`;
  });
  const data = await gql(`query (${defs.join(", ")}) { ${fields.join("\n")} }`, vars);
  const seen = new Map(); // code -> { count, startTime }
  characters.forEach((_, i) => {
    for (const r of data[`c${i}`]?.character?.recentReports?.data ?? []) {
      const entry = seen.get(r.code) ?? { count: 0, startTime: r.startTime };
      entry.count += 1;
      seen.set(r.code, entry);
    }
  });
  return [...seen].filter(([, e]) => e.count >= minPlayers)
    .sort((a, b) => b[1].startTime - a[1].startTime)
    .map(([code]) => code);
}

const REPORT_FIELDS = `
  code startTime
  masterData { actors(type: "Player") { id name server subType } }
  fights { id name startTime endTime kill keystoneLevel keystoneTime keystoneBonus
           friendlyPlayers friendlySpecs averageItemLevel }`;

export async function fetchReports(codes) {
  const reports = [];
  for (let i = 0; i < codes.length; i += 5) {
    const batch = codes.slice(i, i + 5);
    const data = await gql(
      `query (${batch.map((_, j) => `$c${j}: String`).join(", ")}) {
        ${batch.map((_, j) => `r${j}: reportData { report(code: $c${j}, allowUnlisted: true) { ${REPORT_FIELDS} } }`).join("\n")}
      }`,
      Object.fromEntries(batch.map((c, j) => [`c${j}`, c])),
    );
    batch.forEach((_, j) => { const r = data[`r${j}`]?.report; if (r) reports.push(r); });
  }
  return reports;
}

// Mythic+ runs in a report with at least `minPlayers` of the characters in the group.
export function teamRuns(report, characters, minPlayers) {
  const team = characters.map((c) => ({ name: c.name, n: norm(c.name), s: norm(c.realm) }));
  const actors = new Map((report.masterData?.actors ?? []).map((a) => [a.id, a]));
  return (report.fights ?? [])
    .filter((f) => f.keystoneLevel > 0)
    .map((f) => {
      const players = (f.friendlyPlayers ?? []).map((id, i) => {
        const a = actors.get(id);
        if (!a) return null;
        const member = team.find((t) => t.n === norm(a.name) && (!a.server || t.s === norm(a.server)));
        return { actorId: id, name: a.name, className: a.subType ?? "", spec: f.friendlySpecs?.[i] ?? "", team: !!member };
      }).filter(Boolean);
      return { report, fight: f, players };
    })
    .filter((r) => r.players.filter((p) => p.team).length >= minPlayers);
}

// Damage, healing and deaths for one run.
export async function runDetails(code, fightId) {
  const data = await gql(`query ($code: String, $fight: [Int]) {
    reportData { report(code: $code, allowUnlisted: true) {
      dmg: table(dataType: DamageDone, fightIDs: $fight)
      heal: table(dataType: Healing, fightIDs: $fight)
      deaths: table(dataType: Deaths, fightIDs: $fight)
    } } }`, { code, fight: [fightId] });
  const r = data.reportData?.report ?? {};
  const perSecond = (table) => {
    const t = table?.data ?? {};
    const seconds = (t.totalTime ?? 0) / 1000;
    return new Map((t.entries ?? []).map((e) => [e.id, seconds ? Math.round(e.total / seconds) : 0]));
  };
  return {
    dps: perSecond(r.dmg),
    hps: perSecond(r.heal),
    deaths: (r.deaths?.data?.entries ?? []).map((e) => ({
      actorId: e.id,
      name: e.name,
      ability: e.killingBlow?.name ?? e.ability?.name ?? "Unknown",
      timestamp: e.timestamp ?? 0,
    })),
  };
}
