// MelonityPRO activator bot.
// Flow: /start -> user sends the email they registered on the website ->
//        user sends their activation key (from the api-crack key DB) ->
//        account is granted the subscription + private install link.
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import http from "node:http";
import TelegramBot from "node-telegram-bot-api";
import { findUserByEmail, grantSubscription, getRedemption, recordRedemption, config } from "./firebase.js";
import { lookupKey, resolvePlan } from "./keysdb.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Token: env TELEGRAM_BOT_TOKEN (Render) or local token.txt.
function loadToken() {
  if (process.env.TELEGRAM_BOT_TOKEN) return process.env.TELEGRAM_BOT_TOKEN.trim();
  const file = join(__dirname, "..", "token.txt");
  if (existsSync(file)) return readFileSync(file, "utf8").trim();
  throw new Error("No Telegram token: set TELEGRAM_BOT_TOKEN or add token.txt");
}
const token = loadToken();

const bot = new TelegramBot(token, { polling: true });

// Per-chat conversation state: chatId -> { step, email, uid }
const sessions = new Map();
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const esc = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function fmtExpiry(expiresMs) {
  if (!expiresMs) return "Never (Lifetime)";
  return new Date(expiresMs).toLocaleString("en-GB", {
    day: "2-digit", month: "short", year: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
}

// ---------------------------------------------------------------- commands ---

bot.onText(/^\/start\b/, (msg) => {
  const name = esc(msg.from.first_name || "there");
  sessions.delete(msg.chat.id);
  const text =
    `👋 <b>Hey ${name}! Welcome to the ${esc(config.product)} Activator.</b>\n\n` +
    `This bot unlocks <b>${esc(config.product)}</b> on your <b>${esc(config.websiteName)}</b> account and hands you your private install link.\n\n` +
    `<b>How to activate — 3 steps:</b>\n` +
    `1️⃣ Make sure you have an account on ${esc(config.websiteUrl)} (sign up if you haven't).\n` +
    `2️⃣ Tap <b>🚀 Activate</b> below and send the <b>email</b> you registered with.\n` +
    `3️⃣ Send your <b>MelonityPRO key</b> (the same key you use in the app).\n\n` +
    `✅ Done! Your profile will instantly show your subscription and an <b>Install IPA</b> button.\n\n` +
    `Type /activate anytime to begin, or /help for more.`;
  bot.sendMessage(msg.chat.id, text, {
    parse_mode: "HTML",
    disable_web_page_preview: true,
    reply_markup: {
      inline_keyboard: [[{ text: "🚀 Activate", callback_data: "activate" }]],
    },
  });
});

bot.onText(/^\/help\b/, (msg) => {
  const text =
    `<b>${esc(config.product)} Activator — Help</b>\n\n` +
    `/activate — activate your subscription on the website\n` +
    `/cancel — cancel the current activation\n` +
    `/whoami — show your Telegram ID\n\n` +
    `Use the <b>same key</b> you bought for ${esc(config.product)}. ` +
    `Need a key? Contact ${esc(config.sellerContact)}.`;
  bot.sendMessage(msg.chat.id, text, { parse_mode: "HTML" });
});

bot.onText(/^\/whoami\b/, (msg) => {
  bot.sendMessage(msg.chat.id, `Your Telegram ID: <code>${msg.from.id}</code>`, {
    parse_mode: "HTML",
  });
});

bot.onText(/^\/cancel\b/, (msg) => {
  sessions.delete(msg.chat.id);
  bot.sendMessage(msg.chat.id, "❌ Activation cancelled. Type /activate to start again.");
});

bot.onText(/^\/activate\b/, (msg) => startActivation(msg.chat.id));

function startActivation(chatId) {
  sessions.set(chatId, { step: "email" });
  bot.sendMessage(
    chatId,
    `📧 <b>Step 1 of 2</b>\n\nSend me the <b>email address</b> you used to sign up on <b>${esc(
      config.websiteName
    )}</b>.`,
    { parse_mode: "HTML" }
  );
}

// --------------------------------------------------------- button handler ---

bot.on("callback_query", (q) => {
  if (q.data === "activate") {
    bot.answerCallbackQuery(q.id).catch(() => {});
    startActivation(q.message.chat.id);
  }
});

// ------------------------------------------------------- conversation flow ---

bot.on("message", async (msg) => {
  const text = (msg.text || "").trim();
  if (!text || text.startsWith("/")) return; // commands handled elsewhere
  const chatId = msg.chat.id;
  const session = sessions.get(chatId);
  if (!session) return; // idle: ignore stray text

  try {
    if (session.step === "email") {
      const email = text.toLowerCase();
      if (!EMAIL_RE.test(email)) {
        return bot.sendMessage(chatId, "⚠️ That doesn't look like a valid email. Please try again.");
      }
      await bot.sendChatAction(chatId, "typing");
      const user = await findUserByEmail(email);
      if (!user) {
        return bot.sendMessage(
          chatId,
          `❌ No ${esc(config.websiteName)} account found for <b>${esc(email)}</b>.\n\n` +
            `Create one first at ${esc(config.websiteUrl)}, then send the email again.`,
          { parse_mode: "HTML", disable_web_page_preview: true }
        );
      }
      session.email = user.email;
      session.uid = user.uid;
      session.step = "key";
      sessions.set(chatId, session);
      return bot.sendMessage(
        chatId,
        `✅ Account found: <b>${esc(user.email)}</b>\n\n🔑 <b>Step 2 of 2</b>\n\nNow send your <b>${esc(
          config.product
        )} key</b>.`,
        { parse_mode: "HTML" }
      );
    }

    if (session.step === "key") {
      await bot.sendChatAction(chatId, "typing");

      let rec;
      try {
        rec = await lookupKey(text);
      } catch (e) {
        console.error("keyserver:", e.message);
        return bot.sendMessage(
          chatId,
          "⚠️ Couldn't reach the license server right now. Please try again in a moment."
        );
      }
      if (!rec) {
        return bot.sendMessage(
          chatId,
          `❌ Invalid key. Double-check it and send again, or /cancel.\n\nNeed a key? Contact ${esc(
            config.sellerContact
          )}.`,
          { parse_mode: "HTML" }
        );
      }

      let plan;
      try {
        plan = resolvePlan(rec);
      } catch {
        plan = { invalid: true };
      }
      if (plan.invalid) {
        return bot.sendMessage(chatId, "❌ This key isn't configured correctly. Please contact the seller.");
      }
      if (plan.expired) {
        return bot.sendMessage(
          chatId,
          `❌ This key has expired. Grab a new one from ${esc(config.sellerContact)}.`,
          { parse_mode: "HTML" }
        );
      }

      // One key -> one website account (same account may re-activate to refresh).
      const prior = await getRedemption(rec.key);
      if (prior && prior.uid !== session.uid) {
        return bot.sendMessage(
          chatId,
          "❌ This key has already been used to activate another account. Each key unlocks one website account."
        );
      }

      await grantSubscription(
        session.uid,
        { plan: plan.plan, planLabel: plan.label, expiresMs: plan.expiresMs, key: rec.key },
        msg.from.id
      );
      await recordRedemption(rec.key, { uid: session.uid, email: session.email, telegramId: msg.from.id });
      sessions.delete(chatId);

      const text2 =
        `🎉 <b>Activation successful!</b>\n\n` +
        `Your ${esc(config.websiteName)} account <b>${esc(session.email)}</b> now has:\n\n` +
        `📦 <b>Plan:</b> ${esc(config.product)} — ${esc(plan.label)}\n` +
        `⏳ <b>Expires:</b> ${esc(fmtExpiry(plan.expiresMs))}\n\n` +
        `Open your <b>Profile</b> on ${esc(config.websiteName)} — your subscription and the ` +
        `<b>Install IPA</b> button are waiting for you there. Enjoy! 🚀`;
      return bot.sendMessage(chatId, text2, {
        parse_mode: "HTML",
        disable_web_page_preview: true,
        reply_markup: {
          inline_keyboard: [[{ text: "🌐 Open my Profile", url: `${config.websiteUrl}/profile` }]],
        },
      });
    }
  } catch (err) {
    console.error("flow error:", err);
    bot.sendMessage(chatId, "⚠️ Something went wrong on our side. Please try again in a moment.");
  }
});

bot.on("polling_error", (e) => console.error("polling_error:", e.code, e.message));

console.log("MelonityPRO activator bot is running.");
console.log(`Validating keys against: ${config.apiBase}/showall`);

// Render Web Services require an open HTTP port. The bot itself only long-polls Telegram
// (no inbound traffic), so we bind a tiny health endpoint when PORT is provided. On a
// Background Worker PORT is unset and this is skipped.
if (process.env.PORT) {
  http
    .createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("MelonityPRO activator bot: alive");
    })
    .listen(process.env.PORT, () => console.log(`health server listening on :${process.env.PORT}`));
}
