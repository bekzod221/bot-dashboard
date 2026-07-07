// Central config: merges committed config.json (non-secret defaults) with environment
// variables (secrets / host overrides). On Render, set the env vars; locally, a gitignored
// .env file (loaded below) or config.json fills them in.
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Minimal .env loader (no dependency). Real env vars always win.
const envPath = join(__dirname, "..", ".env");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
}

const file = join(__dirname, "..", "config.json");
const base = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};

export const config = {
  product: process.env.PRODUCT || base.product || "MelonityPRO",
  installUrl: process.env.INSTALL_URL || base.installUrl || "",
  websiteName: base.websiteName || "IPA Store",
  websiteUrl: base.websiteUrl || "",
  sellerContact: base.sellerContact || "",
  apiBase: (process.env.API_BASE || base.apiBase || "https://ske2.onrender.com").replace(/\/$/, ""),
  showallSecret: process.env.SHOWALL_SECRET || base.showallSecret || "",
  lifetimeDurations: base.lifetimeDurations || ["365d"],
};
