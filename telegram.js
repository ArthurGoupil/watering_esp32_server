/*
 * ============================================================================
 *  Notifications Telegram
 * ============================================================================
 *  Necessite deux variables d'environnement (config vars Heroku) :
 *    - TELEGRAM_BOT_TOKEN : token du bot (cree via @BotFather sur Telegram)
 *    - TELEGRAM_CHAT_ID   : identifiant de la conversation qui recoit les
 *                           messages (obtenu via l'API getUpdates, voir README)
 *
 *  Si l'une des deux est absente, les notifications sont silencieusement
 *  desactivees (avec un simple log au demarrage) : jamais bloquant pour le
 *  reste du serveur.
 * ============================================================================
 */

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const enabled = Boolean(BOT_TOKEN && CHAT_ID);

async function sendTelegramMessage(text) {
	if (!enabled) return false;
	try {
		const res = await fetch(
			`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ chat_id: CHAT_ID, text, parse_mode: "HTML" }),
			},
		);
		return res.ok;
	} catch {
		return false;
	}
}

module.exports = { sendTelegramMessage, enabled };
