/*
 * ============================================================================
 *  Notifications et webhooks Telegram
 * ============================================================================
 */

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const WEBHOOK_URL = process.env.TELEGRAM_WEBHOOK_URL;
const WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET;
const enabled = Boolean(BOT_TOKEN && CHAT_ID);
const actionButtonsConfigured = Boolean(
	enabled && WEBHOOK_URL && WEBHOOK_SECRET,
);
const TELEGRAM_TIMEOUT_MS = 10_000;

async function callTelegram(method, body) {
	if (!BOT_TOKEN) return false;

	try {
		const res = await fetch(
			`https://api.telegram.org/bot${BOT_TOKEN}/${method}`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
				signal: AbortSignal.timeout(TELEGRAM_TIMEOUT_MS),
			},
		);
		const result = await res.json().catch(() => null);
		if (!res.ok || result?.ok !== true) {
			console.error(
				`[Telegram] ${method} failed: HTTP ${res.status}${
					result?.description ? ` (${result.description})` : ""
				}`,
			);
			return false;
		}
		return true;
	} catch (err) {
		console.error(`[Telegram] ${method} failed: ${err.message}`);
		return false;
	}
}

async function sendTelegramMessage(text, { inlineKeyboard } = {}) {
	if (!enabled) return false;

	const body = { chat_id: CHAT_ID, text, parse_mode: "HTML" };
	if (inlineKeyboard) {
		body.reply_markup = { inline_keyboard: inlineKeyboard };
	}
	return callTelegram("sendMessage", body);
}

async function answerCallbackQuery(callbackQueryId, text) {
	if (!callbackQueryId) {
		console.error("[Telegram] answerCallbackQuery skipped: callback ID missing.");
		return false;
	}
	return callTelegram("answerCallbackQuery", {
		callback_query_id: callbackQueryId,
		text,
	});
}

async function registerWebhook() {
	if (!actionButtonsConfigured) return false;

	let url;
	try {
		url = new URL(WEBHOOK_URL);
	} catch {
		console.error("[Telegram] Webhook non enregistre : TELEGRAM_WEBHOOK_URL invalide.");
		return false;
	}
	if (url.protocol !== "https:") {
		console.error("[Telegram] Webhook non enregistre : TELEGRAM_WEBHOOK_URL doit utiliser HTTPS.");
		return false;
	}

	return callTelegram("setWebhook", {
		url: WEBHOOK_URL,
		secret_token: WEBHOOK_SECRET,
		allowed_updates: ["callback_query"],
	});
}

module.exports = {
	sendTelegramMessage,
	answerCallbackQuery,
	registerWebhook,
	enabled,
	actionButtonsConfigured,
	chatId: CHAT_ID,
	webhookSecret: WEBHOOK_SECRET,
};
