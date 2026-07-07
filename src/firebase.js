// Firebase Admin wrapper: resolve users by email, write subscription docs, and keep the
// redemption ledger in Firestore (durable across Render restarts / ephemeral disks).
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import admin from "firebase-admin";
import { config } from "./config.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Credentials: env FIREBASE_SERVICE_ACCOUNT (full JSON string) for hosts like Render,
// else the local serviceAccount.json file.
function loadServiceAccount() {
  const envJson = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (envJson) return JSON.parse(envJson);
  const file = join(__dirname, "..", "serviceAccount.json");
  if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8"));
  throw new Error("No Firebase credentials: set FIREBASE_SERVICE_ACCOUNT or add serviceAccount.json");
}

admin.initializeApp({ credential: admin.credential.cert(loadServiceAccount()) });

const db = admin.firestore();

// Find a website account by the email they signed up with.
export async function findUserByEmail(email) {
  try {
    const user = await admin.auth().getUserByEmail(email.trim().toLowerCase());
    return { uid: user.uid, email: user.email };
  } catch (err) {
    if (err.code === "auth/user-not-found") return null;
    throw err;
  }
}

// Write the subscription onto the user's profile (subscriptions/{uid}).
// The install link lives ONLY here — it is never shipped in the website source.
// `sub` = { plan, planLabel, expiresMs (null = lifetime), key }.
export async function grantSubscription(uid, sub, telegramId) {
  const now = Date.now();
  const data = {
    product: config.product,
    plan: sub.plan,
    planLabel: sub.planLabel,
    installLink: config.installUrl,
    status: "active",
    key: sub.key,
    activatedVia: "telegram",
    telegramId: telegramId ?? null,
    activatedAt: admin.firestore.Timestamp.fromMillis(now),
    expiresAt: sub.expiresMs ? admin.firestore.Timestamp.fromMillis(sub.expiresMs) : null,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };
  await db.collection("subscriptions").doc(uid).set(data, { merge: true });
  return { expiresMs: sub.expiresMs ?? null };
}

// ---- redemption ledger (one key -> one website account), stored in Firestore ----------
// Firestore doc IDs can't contain "/", so we sanitize just in case.
const ledgerId = (key) => String(key).replace(/\//g, "_").slice(0, 400);

export async function getRedemption(key) {
  const snap = await db.collection("keyRedemptions").doc(ledgerId(key)).get();
  return snap.exists ? snap.data() : null;
}

export async function recordRedemption(key, { uid, email, telegramId }) {
  await db.collection("keyRedemptions").doc(ledgerId(key)).set({
    key: String(key),
    uid,
    email,
    telegramId: telegramId ?? null,
    activatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
}

export { config };
