// Validates activation keys against the deployed api-crack auth server (/showall).
// That endpoint is secret-guarded, so we send the shared admin secret. We only READ —
// we never bind HWID or mutate the auth server's data.
// (The one-key-one-account ledger lives in Firestore — see firebase.js.)
import { config } from "./config.js";

// ---- api-crack key DB (via secret-guarded /showall) ------------------------

// Thrown on network / auth failure so the bot can tell "server down" apart from "invalid key".
export class KeyServerError extends Error {}

async function fetchAllKeys() {
  const url = `${config.apiBase.replace(/\/$/, "")}/showall`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000); // Render can cold-start slowly
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: { "x-admin-secret": config.showallSecret, Accept: "application/json" },
      signal: controller.signal,
    });
    if (res.status === 401) throw new KeyServerError("unauthorized (bad showallSecret)");
    if (!res.ok) throw new KeyServerError(`showall HTTP ${res.status}`);
    const data = await res.json();
    return Array.isArray(data) ? data : [];
  } catch (err) {
    if (err instanceof KeyServerError) throw err;
    throw new KeyServerError(err.name === "AbortError" ? "license server timed out" : err.message);
  } finally {
    clearTimeout(timeout);
  }
}

// Mirror of the auth server's matching: exact key, trimmed. Throws KeyServerError if unreachable.
export async function lookupKey(rawKey) {
  const key = String(rawKey || "").trim();
  if (!key) return null;
  const db = await fetchAllKeys();
  return db.find((item) => String(item.key) === key) || null;
}

// ---- duration / plan helpers (mirror the auth server) ----------------------

const UNIT = {
  d: ["Day", "Days"],
  h: ["Hour", "Hours"],
  m: ["Minute", "Minutes"],
  s: ["Second", "Seconds"],
};

function parseDuration(durationStr) {
  const m = String(durationStr).match(/^(\d+)([dhms])$/);
  if (!m) throw new Error("bad duration");
  const amount = parseInt(m[1], 10);
  const mult = { d: 86400000, h: 3600000, m: 60000, s: 1000 }[m[2]];
  return amount * mult;
}

function humanizeDuration(durationStr) {
  const m = String(durationStr).match(/^(\d+)([dhms])$/);
  if (!m) return String(durationStr);
  const n = parseInt(m[1], 10);
  const [one, many] = UNIT[m[2]];
  return `${n} ${n === 1 ? one : many}`;
}

// Auth server stores dates as "DD.MM.YYYY HH:MM:SS" in local time.
function parseServerDate(dateStr) {
  const [datePart, timePart] = String(dateStr).split(" ");
  const [day, month, year] = datePart.split(".");
  const [h, mi, s] = (timePart || "0:0:0").split(":");
  return new Date(+year, +month - 1, +day, +h, +mi, +s);
}

// Resolve a key record into { plan, label, expiresMs, expired }.
// - Lifetime durations (config.lifetimeDurations) -> no expiry.
// - Otherwise use the key's own expiresAt if already set, else now + duration.
export function resolvePlan(rec) {
  const duration = rec.duration || null;

  if (duration && (config.lifetimeDurations || []).includes(duration)) {
    return { plan: duration, label: "Lifetime", expiresMs: null, expired: false };
  }

  let expiresMs = null;
  if (rec.expiresAt) {
    expiresMs = parseServerDate(rec.expiresAt).getTime();
  } else if (duration) {
    expiresMs = Date.now() + parseDuration(duration); // starts now for the website
  } else {
    // No duration and no expiry — cannot determine a plan.
    return { plan: "unknown", label: "Unknown", expiresMs: null, expired: false, invalid: true };
  }

  const label = duration ? humanizeDuration(duration) : "Premium";
  const expired = expiresMs != null && expiresMs < Date.now();
  return { plan: duration || "premium", label, expiresMs, expired };
}
