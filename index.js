/*
 * ============================================================================
 *  Serveur d'arrosage automatique — version avec persistence PostgreSQL
 * ============================================================================
 *
 *  Endpoints ESP32 (inchanges, compatibles firmware existant) :
 *    GET /init?tank_level=...   -> log + enregistrement, repond 204
 *    GET /water?tank_level=...  -> log + enregistrement, renvoie la duree
 *                                  d'arrosage du jour (reglages ou vacances)
 *
 *  API de l'application mobile (PWA) :
 *    GET  /api/status        -> derniere mesure, volume, pourcentage
 *    GET  /api/waterings     -> historique des arrosages
 *    GET  /api/measurements  -> historique des mesures brutes
 *    GET  /api/settings      -> reglages (duree quotidienne, debit)
 *    PUT  /api/settings      -> mise a jour des reglages
 *    GET  /api/vacation      -> etat du mode vacances
 *    PUT  /api/vacation      -> activation/desactivation du mode vacances
 *
 *  L'application React buildee est servie depuis public/.
 *
 *  Resilience : si la base est injoignable, /water renvoie la duree de
 *  secours FALLBACK_WATERING_SECONDS pour ne jamais priver les plantes d'eau.
 * ============================================================================
 */

const express = require("express");
const path = require("path");
const { randomUUID, timingSafeEqual } = require("crypto");
const db = require("./db");
const {
	sendTelegramMessage,
	answerCallbackQuery,
	registerWebhook,
	enabled: telegramEnabled,
	actionButtonsConfigured,
	chatId: telegramChatId,
	webhookSecret: telegramWebhookSecret,
} = require("./telegram");

const PORT = process.env.PORT || 3000;
const FALLBACK_WATERING_SECONDS = 500;

// Heure quotidienne d'arrosage (doit correspondre a WATERING_HOUR du firmware)
// + marge de tolerance avant de considerer le reveil comme manque.
const WATERING_HOUR = 8;
const MISSED_WATERING_GRACE_MINUTES = 45;
const MISSED_WATERING_CHECK_INTERVAL_MS = 5 * 60 * 1000;
const WEATHER_RETRY_ATTEMPTS = 3;
const WEATHER_RETRY_DELAY_MS = 5 * 60 * 1000;
const RAIN_THRESHOLD_MM = 6;
const SAINT_OUEN_LATITUDE = 48.911;
const SAINT_OUEN_LONGITUDE = 2.334;
const weatherSchedulerSecret = process.env.WEATHER_SCHEDULER_SECRET;

const app = express();
app.use(express.json());
let telegramActionButtonsEnabled = false;
let wateringDisabledInMemory = false;

function log(...args) {
	console.log(`[${new Date().toISOString()}]`, ...args);
}

function webhookSecretMatches(receivedSecret) {
	if (
		typeof receivedSecret !== "string" ||
		typeof telegramWebhookSecret !== "string"
	) {
		return false;
	}
	const received = Buffer.from(receivedSecret);
	const expected = Buffer.from(telegramWebhookSecret);
	return (
		received.length === expected.length &&
		timingSafeEqual(received, expected)
	);
}

function secretMatches(receivedSecret, expectedSecret) {
	if (
		typeof receivedSecret !== "string" ||
		typeof expectedSecret !== "string"
	) {
		return false;
	}
	const received = Buffer.from(receivedSecret);
	const expected = Buffer.from(expectedSecret);
	return (
		received.length === expected.length &&
		timingSafeEqual(received, expected)
	);
}

function weatherSchedulerSecretMatches(receivedSecret) {
	return secretMatches(receivedSecret, weatherSchedulerSecret);
}

async function getWeatherForecast() {
	const url = new URL("https://api.open-meteo.com/v1/forecast");
	url.search = new URLSearchParams({
		latitude: String(SAINT_OUEN_LATITUDE),
		longitude: String(SAINT_OUEN_LONGITUDE),
		daily: "temperature_2m_min,precipitation_sum",
		forecast_days: "7",
		timezone: "Europe/Paris",
	}).toString();

	const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
	if (!response.ok) {
		throw new Error(`Open-Meteo HTTP ${response.status}`);
	}
	const data = await response.json();
	const { time, temperature_2m_min: minimums, precipitation_sum: precipitation } =
		data.daily ?? {};
	if (
		!Array.isArray(time) ||
		!Array.isArray(minimums) ||
		!Array.isArray(precipitation) ||
		time.length === 0 ||
		time.length !== minimums.length ||
		time.length !== precipitation.length
	) {
		throw new Error("reponse Open-Meteo quotidienne invalide");
	}

	return time.map((date, index) => {
		const temperatureMin = Number(minimums[index]);
		const precipitationMm = Number(precipitation[index]);
		if (!Number.isFinite(temperatureMin) || !Number.isFinite(precipitationMm)) {
			throw new Error("valeur meteorologique invalide");
		}
		return { date, temperatureMin, precipitationMm };
	});
}

async function checkWeatherAlerts() {
	if (!telegramEnabled) {
		throw new Error("notifications Telegram indisponibles");
	}

	const forecast = await getWeatherForecast();
	await db.recordWeatherSnapshot(forecast);
	const frostDecision = await db.evaluateFrostAlert(forecast);
	if (frostDecision.rearmed) {
		log("checkWeatherAlerts -> alertes gel rearmees : previsions toutes >= 5 C.");
	}
	if (frostDecision.shouldAlert) {
		const coldestDay = forecast.reduce((coldest, day) =>
			day.temperatureMin < coldest.temperatureMin ? day : coldest,
		);
		const sent = await sendTelegramMessage(
			`❄️ Risque de froid : ${coldestDay.temperatureMin} °C minimum prévu le ${coldestDay.date} à Saint-Ouen-sur-Seine. Débranchez la batterie LiFePO4 si nécessaire.`,
			telegramActionButtonsEnabled
				? {
						inlineKeyboard: [
							[
								{
									text: "Me le rappeler demain",
									callback_data: `frost:tomorrow:${frostDecision.deliveryId}`,
								},
							],
							[
								{
									text: "Masquer jusqu’au retour au chaud",
									callback_data: `frost:until_safe:${frostDecision.deliveryId}`,
								},
							],
						],
					}
				: undefined,
		);
		await db.completeFrostAlertDelivery(frostDecision.deliveryId, sent);
		if (!sent) throw new Error("envoi de l’alerte gel impossible");
		log(
			`checkWeatherAlerts -> alerte gel envoyee (${coldestDay.temperatureMin} C le ${coldestDay.date}).`,
		);
	}

	const today = db.localDate();
	const todayForecast = forecast.find((day) => day.date === today);
	if (
		todayForecast &&
		todayForecast.precipitationMm >= RAIN_THRESHOLD_MM &&
		(await db.getRawSetting("last_rain_alert_date")) !== today
	) {
		const deliveryId = randomUUID();
		const sent = await sendTelegramMessage(
			`🌧️ Environ ${todayForecast.precipitationMm} mm de pluie aujourd’hui à Saint-Ouen-sur-Seine. Maintenir l’arrosage automatique de demain ?`,
			telegramActionButtonsEnabled
				? {
						inlineKeyboard: [
							[
								{ text: "Oui, maintenir", callback_data: `rain:keep:${deliveryId}` },
								{ text: "Non, annuler demain", callback_data: `rain:skip:${deliveryId}` },
							],
						],
					}
				: undefined,
		);
		if (!sent) throw new Error("envoi de l’alerte pluie impossible");
		await Promise.all([
			db.setSetting("last_rain_alert_date", today),
			db.setSetting("rain_alert_date", today),
			db.setSetting("rain_alert_delivery_id", deliveryId),
		]);
		log(`checkWeatherAlerts -> alerte pluie envoyee (${todayForecast.precipitationMm} mm).`);
	}
}

const sleep = (milliseconds) =>
	new Promise((resolve) => setTimeout(resolve, milliseconds));

async function checkWeatherAlertsWithRetries() {
	let lastError;
	for (let attempt = 1; attempt <= WEATHER_RETRY_ATTEMPTS; attempt += 1) {
		try {
			await checkWeatherAlerts();
			return;
		} catch (err) {
			lastError = err;
			log(
				`checkWeatherAlerts -> ECHEC tentative ${attempt}/${WEATHER_RETRY_ATTEMPTS} : ${err.message}`,
			);
			if (attempt < WEATHER_RETRY_ATTEMPTS) {
				await sleep(WEATHER_RETRY_DELAY_MS);
			}
		}
	}
	throw lastError;
}

async function handleTankMeasurement(m, endpoint) {
	try {
		const decision = await db.evaluateLowTankLevel(m.tankLevel);
		if (decision.rearmed) {
			log(
				`${endpoint} -> cuve refaite au-dessus de 5 % : alerte de niveau bas rearmee`,
			);
		}
		if (!decision.shouldAlert) return;

		const hasActionButtons = telegramActionButtonsEnabled;
		const sent = await sendTelegramMessage(
			`⚠️ Réservoir presque vide : niveau mesuré ${m.tankLevel} %. ${
				hasActionButtons
					? "Choisissez : Oui désactive l’arrosage ; Non le maintient et alertera à nouveau à la prochaine mesure basse ; Désactiver l’alerte maintient l’arrosage et coupe ces alertes jusqu’au remplissage."
					: "Les boutons d’action Telegram ne sont pas configurés."
			}`,
			hasActionButtons
				? {
						inlineKeyboard: [
							[
								{ text: "Oui", callback_data: `low_tank:disable:${decision.deliveryId}` },
								{ text: "Non", callback_data: `low_tank:keep:${decision.deliveryId}` },
							],
							[
								{ text: "Désactiver l’alerte", callback_data: `low_tank:mute:${decision.deliveryId}` },
							],
						],
					}
				: undefined,
		);
		await db.completeLowTankAlertDelivery(decision.deliveryId, sent);
		if (sent) {
			log(
				`${endpoint} -> alerte Telegram de cuve <= 5 % envoyee${
					hasActionButtons ? " avec boutons d’action" : ""
				}`,
			);
		} else {
			log(
				`${endpoint} -> ECHEC alerte Telegram de cuve <= 5 % : nouvelle tentative a la prochaine mesure`,
			);
		}
	} catch (err) {
		log(`${endpoint} -> ERREUR traitement alerte niveau bas : ${err.message}`);
	}
}

// --- Lecture des parametres envoyes par l'ESP32 ---
function parseEsp32Query(query) {
	const num = (name) => {
		const raw = query[name];
		if (raw === undefined || raw === null || raw === "") return null;
		const value = Number(raw);
		return Number.isFinite(value) ? value : null;
	};
	return {
		tankLevel: num("tank_level"),
		rawDistanceCm: num("raw_distance_cm"),
		validSamples: num("valid_samples"),
		readAttempts: num("read_attempts"),
		attemptedSamples: num("attempted_samples"),
		timeoutSamples: num("timeout_samples"),
		outOfRangeSamples: num("out_of_range_samples"),
		echoIdleHighSamples: num("echo_idle_high_samples"),
	};
}

function logMeasurement(endpoint, m) {
	const distanceInfo =
		m.rawDistanceCm === null ? "" : ` (distance brute = ${m.rawDistanceCm} cm)`;
	const diagnosticInfo =
		m.validSamples === null && m.readAttempts === null
			? ""
			: ` [echantillons valides = ${m.validSamples}, tentatives = ${m.readAttempts}]`;
	const detailedInfo =
		m.attemptedSamples === null
			? ""
			: ` [total = ${m.attemptedSamples}, sans echo = ${m.timeoutSamples}, hors plage = ${m.outOfRangeSamples}, ECHO haut au repos = ${m.echoIdleHighSamples}]`;

	if (m.tankLevel < 0) {
		log(`${endpoint}  -> CAPTEUR EN PANNE (tank_level=${m.tankLevel})${distanceInfo}${diagnosticInfo}${detailedInfo}`);
	} else {
		log(`${endpoint}  -> niveau cuve = ${m.tankLevel} %${distanceInfo}${diagnosticInfo}${detailedInfo}`);
	}

	if (m.echoIdleHighSamples > 0) {
		log(`${endpoint}  -> diagnostic probable : ligne ECHO anormalement HIGH au repos (cablage, level shifter ou capteur)`);
	} else if (m.attemptedSamples > 0 && m.timeoutSamples === m.attemptedSamples) {
		log(`${endpoint}  -> diagnostic : aucun echo recu (alimentation/cablage OU cible/positionnement)`);
	} else if (m.outOfRangeSamples > 0) {
		log(`${endpoint}  -> diagnostic probable : echoes recus mais hors plage (positionnement, reflexions ou cible)`);
	}
}

// --- Routes ESP32 ---
app.get(["/init", "/water"], async (req, res) => {
	const endpoint = req.path;
	const m = parseEsp32Query(req.query);

	if (m.tankLevel === null) {
		log(`${endpoint} APPEL INVALIDE (tank_level manquant ou non numerique)`);
		return res.status(400).json({ error: "tank_level manquant ou invalide" });
	}

	logMeasurement(endpoint, m);
	await handleTankMeasurement(m, endpoint);

	let measurementId = null;
	try {
		measurementId = await db.insertMeasurement(endpoint, m);
	} catch (err) {
		log(`${endpoint}  -> ERREUR DB (mesure non enregistree) : ${err.message}`);
	}

	if (endpoint === "/init") {
		return res.status(204).end();
	}

	// Duree d'arrosage du jour : reglages ou mode vacances.
	let seconds = wateringDisabledInMemory ? 0 : FALLBACK_WATERING_SECONDS;
	let source = wateringDisabledInMemory ? "disabled" : "fallback";
	try {
		const decision = await db.computeWateringSeconds();
		seconds = decision.seconds;
		source = decision.source;
	} catch (err) {
		log(
			wateringDisabledInMemory
				? `/water  -> ERREUR DB, pompe maintenue bloquee : ${err.message}`
				: `/water  -> ERREUR DB (duree de secours ${FALLBACK_WATERING_SECONDS}s utilisee) : ${err.message}`,
		);
	}

	log(`/water  -> duree d'arrosage renvoyee = ${seconds}s (source : ${source})`);

	// Only one automatic watering is allowed per Paris-local day. This is
	// enforced atomically in PostgreSQL so an ESP32 reboot, a retry, or an
	// unexpected second client can never receive a second pump duration.
	try {
		if (seconds > 0) {
			const settings = await db.getSettings();
			const interpretation = db.interpretDistance(m.rawDistanceCm);
			const result = await db.recordAutomaticWateringOnceToday({
				requestedSeconds: seconds,
				source,
				distanceBeforeCm: m.rawDistanceCm >= 0 ? m.rawDistanceCm : null,
				tankPercentBefore: interpretation.percent,
				tankLitersBefore:
					interpretation.liters === null
						? null
						: Math.round(interpretation.liters * 10) / 10,
				estimatedLitersFlow:
					Math.round((seconds / 60) * settings.flow_l_per_min * 10) / 10,
				measurementId,
			});
			if (!result.created) {
				log(
					result.disabled
						? "/water  -> arrosage automatique bloque : arrosage desactive"
						: `/water  -> arrosage automatique deja enregistre aujourd'hui (id=${result.id}) : 0s renvoye`,
				);
				seconds = 0;
				source = result.disabled ? "disabled" : "duplicate";
			}
		}
		if (
			seconds > 0 &&
			m.rawDistanceCm !== null &&
			m.rawDistanceCm >= 0
		) {
			await db.estimatePreviousWateringFromSensor(m.rawDistanceCm);
		}
	} catch (err) {
		log(`/water  -> ERREUR DB (pompe bloquee par securite) : ${err.message}`);
		return res.status(503).json({
			ok: false,
			error: "impossible de verifier l'arrosage quotidien",
			watering_seconds: 0,
		});
	}

	res.json({
		ok: true,
		received_tank_level: m.tankLevel,
		received_raw_distance_cm: m.rawDistanceCm,
		watering_seconds: seconds,
	});
});

// --- Sondage de commande (reveil "check-in" leger, toutes les 2h, sans
// mesure ni WiFi de longue duree) : indique si un arrosage exceptionnel a ete
// demande depuis l'app. ---
app.get("/command", async (req, res) => {
	try {
		const [command, watering] = await Promise.all([
			db.getCommand(),
			db.getWateringStatus(),
		]);
		res.json({
			watering_requested:
				watering.enabled && Boolean(command.manual_watering_requested),
			requested_seconds: watering.enabled ? command.requested_seconds : null,
			request_id: command.request_id,
			watering_enabled: watering.enabled,
		});
	} catch (err) {
		res.status(500).json({ error: err.message });
		log(`/command  -> ERREUR DB : ${err.message}`);
	}
});

// Appele par l'ESP32 juste avant de lancer la pompe pour un arrosage
// exceptionnel (mesure prise avec le WiFi deja connecte, cas rare accepte).
// request_id doit correspondre exactement a la commande recue via /command :
// si elle a ete annulee/remplacee entre-temps, la requete est refusee (ok:false)
// et l'ESP32 ne doit PAS activer la pompe.
app.get("/manual-water", async (req, res) => {
	const m = parseEsp32Query(req.query);
	const seconds = Math.round(Number(req.query.seconds));
	const requestId = Number(req.query.request_id);

	if (
		m.tankLevel === null ||
		Number.isNaN(seconds) ||
		seconds <= 0 ||
		Number.isNaN(requestId)
	) {
		log("/manual-water APPEL INVALIDE (parametre manquant ou invalide)");
		return res.status(400).json({ error: "parametres manquants ou invalides" });
	}

	logMeasurement("/manual-water", m);
	await handleTankMeasurement(m, "/manual-water");

	let measurementId = null;
	try {
		measurementId = await db.insertMeasurement("/manual-water", m);

		const result = await db.recordManualWatering(
			requestId,
			seconds,
			measurementId,
			m.rawDistanceCm,
		);
		if (result.cancelled) {
			log(
				`/manual-water  -> commande ${
					result.disabled ? "bloquee (arrosage desactive)" : "annulee/remplacee"
				} (request_id=${requestId}) : pompe non activee`,
			);
			return res.json({
				ok: false,
				cancelled: true,
				disabled: Boolean(result.disabled),
				watering_seconds: 0,
			});
		}

		if (m.rawDistanceCm !== null && m.rawDistanceCm >= 0) {
			await db.estimatePreviousWateringFromSensor(m.rawDistanceCm);
		}
	} catch (err) {
		log(`/manual-water  -> ERREUR DB : ${err.message}`);
		return res
			.status(500)
			.json({ ok: false, error: err.message, watering_seconds: 0 });
	}

	log(`/manual-water  -> arrosage exceptionnel demarre = ${seconds}s`);
	sendTelegramMessage(
		`🚿 Arrosage exceptionnel démarré : ${seconds}s.`,
	);

	res.json({ ok: true, watering_seconds: seconds, measurement_id: measurementId });
});

// Appele par l'ESP32 juste apres la fin de la pompe (arrosage exceptionnel).
// request_id makes retries safe: an ESP32 may not receive a successful HTTP
// response and retry, but Telegram must still receive one completion message.
app.get("/manual-water/done", async (req, res) => {
	const requestId = Number(req.query.request_id);
	if (!Number.isInteger(requestId) || requestId <= 0) {
		return res.status(400).json({ error: "request_id manquant ou invalide" });
	}

	try {
		const settingKey = "last_manual_watering_done_request_id";
		const lastCompletedRequestId = await db.getRawSetting(settingKey);
		if (lastCompletedRequestId === String(requestId)) {
			log(`/manual-water/done  -> deja traite (request_id=${requestId})`);
			return res.status(204).end();
		}

		const sent = await sendTelegramMessage("✅ Arrosage exceptionnel terminé.");
		if (!sent) {
			log(`/manual-water/done  -> ECHEC envoi Telegram (request_id=${requestId})`);
			return res.status(503).json({ error: "notification Telegram non envoyee" });
		}

		await db.setSetting(settingKey, requestId);
		log(`/manual-water/done  -> arrosage exceptionnel termine (request_id=${requestId})`);
		res.status(204).end();
	} catch (err) {
		log(`/manual-water/done  -> ERREUR : ${err.message}`);
		res.status(500).json({ error: err.message });
	}
});

// Telegram delivers button presses as HTTPS webhooks. The shared secret is
// mandatory so only Telegram requests registered by this process are trusted.
app.post("/telegram/webhook", async (req, res) => {
	if (!telegramActionButtonsEnabled) {
		log("/telegram/webhook -> refuse : boutons Telegram indisponibles.");
		return res.status(503).json({ error: "webhook Telegram indisponible" });
	}
	if (!webhookSecretMatches(req.get("X-Telegram-Bot-Api-Secret-Token"))) {
		log("/telegram/webhook -> refuse : secret Telegram invalide.");
		return res.status(403).json({ error: "secret Telegram invalide" });
	}

	const callback = req.body?.callback_query;
	if (!callback) {
		return res.status(204).end();
	}
	if (String(callback.message?.chat?.id) !== String(telegramChatId)) {
		log("/telegram/webhook -> refuse : chat Telegram non autorise.");
		return res.status(403).json({ error: "chat Telegram non autorise" });
	}

	try {
		const actionMatch = /^low_tank:(disable|keep|mute):([0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})$/.exec(
			String(callback.data),
		);
		const frostMatch = /^frost:(tomorrow|until_safe):([0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})$/.exec(
			String(callback.data),
		);
		const rainMatch = /^rain:(keep|skip):([0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})$/.exec(
			String(callback.data),
		);
		if (!actionMatch && !frostMatch && !rainMatch) {
			log(`/telegram/webhook -> callback inconnu ignore : ${String(callback.data)}`);
			const answered = await answerCallbackQuery(callback.id, "Action inconnue.");
			return answered
				? res.status(200).json({ ok: true })
				: res.status(502).json({ error: "reponse Telegram non envoyee" });
		}

		if (frostMatch) {
			const [, action, deliveryId] = frostMatch;
			const result = await db.respondToFrostAlert(deliveryId, action);
			const message = !result.accepted
				? "Cette alerte n’est plus active."
				: action === "tomorrow"
					? "D’accord, rappel demain soir si le risque persiste."
					: "Alertes masquees jusqu’a ce que toute la prevision repasse a 5 °C ou plus.";
			const answered = await answerCallbackQuery(callback.id, message);
			if (!answered) {
				log("/telegram/webhook -> ECHEC answerCallbackQuery (alerte gel).");
				return res.status(502).json({ error: "reponse Telegram non envoyee" });
			}
			log(`/telegram/webhook -> action gel ${action} ${result.accepted ? "acceptee" : "obsolete"}.`);
			return res.status(200).json({ ok: true, stale: !result.accepted });
		}

		if (rainMatch) {
			const [, action, deliveryId] = rainMatch;
			const result = await db.respondToRainAlert(deliveryId, action);
			const message = !result.accepted
				? "Cette alerte n’est plus active."
				: action === "skip"
					? "Arrosage automatique de demain annule."
					: "Arrosage automatique de demain maintenu.";
			const answered = await answerCallbackQuery(callback.id, message);
			if (!answered) {
				log("/telegram/webhook -> ECHEC answerCallbackQuery (alerte pluie).");
				return res.status(502).json({ error: "reponse Telegram non envoyee" });
			}
			log(`/telegram/webhook -> action pluie ${action} ${result.accepted ? "acceptee" : "obsolete"}.`);
			return res.status(200).json({ ok: true, stale: !result.accepted });
		}

		const [, action, deliveryId] = actionMatch;
		const result = await db.respondToLowTankAlert(deliveryId, action);
		if (!result.accepted) {
			const answered = await answerCallbackQuery(
				callback.id,
				"Cette alerte n’est plus active.",
			);
			if (!answered) {
				log("/telegram/webhook -> ECHEC answerCallbackQuery (alerte obsolete).");
				return res.status(502).json({ error: "reponse Telegram non envoyee" });
			}
			log(`/telegram/webhook -> action obsolete ignoree (${action}).`);
			return res.status(200).json({ ok: true, stale: true });
		}

		if (action === "disable") {
			wateringDisabledInMemory = true;
			log(
				`/telegram/webhook -> arrosage desactive via Telegram${
					result.hadPendingRequest
						? " ; demande manuelle en attente annulee"
						: ""
				}`,
			);
			const answered = await answerCallbackQuery(
				callback.id,
				result.alreadyDisabled
					? "L’arrosage est déjà désactivé."
					: "Arrosage désactivé. Réactivez-le manuellement dans l’application.",
			);
			if (!answered) {
				log("/telegram/webhook -> ECHEC answerCallbackQuery (action deja enregistree).");
				return res.status(502).json({ error: "reponse Telegram non envoyee" });
			}
			return res.status(200).json({ ok: true });
		}

		if (action === "keep") {
			const answered = await answerCallbackQuery(
				callback.id,
				"Arrosage maintenu. La prochaine mesure basse declenchera une nouvelle alerte.",
			);
			if (!answered) {
				log("/telegram/webhook -> ECHEC answerCallbackQuery.");
				return res.status(502).json({ error: "reponse Telegram non envoyee" });
			}
			log("/telegram/webhook -> arrosage maintenu ; prochaine mesure basse alertera.");
			return res.status(200).json({ ok: true });
		}

		const answered = await answerCallbackQuery(
			callback.id,
			"Alertes de cuve basse coupees jusqu’a une mesure superieure a 5 %. Arrosage maintenu.",
		);
		if (!answered) {
			log("/telegram/webhook -> ECHEC answerCallbackQuery.");
			return res.status(502).json({ error: "reponse Telegram non envoyee" });
		}
		log("/telegram/webhook -> alertes de cuve basse desactivees ; arrosage maintenu.");
		return res.status(200).json({ ok: true });
	} catch (err) {
		log(`/telegram/webhook -> ERREUR : ${err.message}`);
		return res.status(500).json({ error: "traitement du callback impossible" });
	}
});

// Appele par l'ESP32 juste avant chaque endormissement (WiFi encore
// connecte) : indique quand aura lieu le prochain reveil, pour affichage
// dans l'app.
app.get("/next-wake", async (req, res) => {
	try {
		const seconds = Number(req.query.seconds);
		const fullCycle = req.query.full_cycle === "true";
		if (Number.isNaN(seconds) || seconds <= 0) {
			return res.status(400).json({ error: "seconds manquant ou invalide" });
		}
		await db.setNextWake(seconds, fullCycle);
		res.status(204).end();
	} catch (err) {
		log(`/next-wake  -> ERREUR DB : ${err.message}`);
		res.status(500).json({ error: err.message });
	}
});

// Sent by the ESP32 on the next successful WiFi connection after a reset.
// The firmware keeps a short RTC event ring plus its last flash-persisted
// checkpoint, so a manual reboot can reveal the last step reached before a
// watchdog, panic, or power-related reset.
app.post("/device-diagnostics", async (req, res) => {
	const { reset_reason: resetReason, persistent_checkpoint: checkpoint, events } =
		req.body ?? {};
	if (
		!Number.isInteger(resetReason) ||
		(checkpoint !== null && checkpoint !== undefined && typeof checkpoint !== "string") ||
		!Array.isArray(events) ||
		events.length > 30 ||
		events.some((event) => typeof event !== "string" || event.length > 120)
	) {
		return res.status(400).json({ error: "diagnostic ESP32 invalide" });
	}

	try {
		const id = await db.insertDeviceDiagnostics({
			resetReason,
			persistentCheckpoint: checkpoint || null,
			events,
		});
		log(
			`/device-diagnostics -> enregistre id=${id}, reset=${resetReason}, events=${events.length}`,
		);
		res.status(204).end();
	} catch (err) {
		log(`/device-diagnostics -> ERREUR DB : ${err.message}`);
		res.status(500).json({ error: err.message });
	}
});

// Called only by the daily Cloud Scheduler job. The dedicated secret prevents
// a public request from consuming the daily weather check or sending alerts.
app.post("/internal/weather-check", async (req, res) => {
	if (!weatherSchedulerSecret) {
		log("/internal/weather-check -> refuse : WEATHER_SCHEDULER_SECRET absent.");
		return res.status(503).json({ error: "planificateur meteo indisponible" });
	}
	if (!weatherSchedulerSecretMatches(req.get("X-Weather-Scheduler-Secret"))) {
		log("/internal/weather-check -> refuse : secret invalide.");
		return res.status(403).json({ error: "secret invalide" });
	}

	try {
		await checkWeatherAlertsWithRetries();
		log("/internal/weather-check -> controle meteo termine.");
		return res.status(204).end();
	} catch (err) {
		log(`/internal/weather-check -> ECHEC definitif : ${err.message}`);
		return res.status(503).json({ error: "controle meteo impossible" });
	}
});

// --- API de l'application ---
app.get("/api/status", async (req, res) => {
	try {
		const [measurement, settings, vacation, nextWake, watering, weather] = await Promise.all([
			db.latestMeasurement(),
			db.getSettings(),
			db.getVacation(),
			db.getNextWake(),
			db.getWateringStatus(),
			db.getWeatherStatus(),
		]);

		let tank = null;
		if (measurement) {
			const distance =
				measurement.raw_distance_cm !== null && measurement.raw_distance_cm >= 0
					? measurement.raw_distance_cm
					: null;
			const interpretation = db.interpretDistance(distance);
			tank = {
				measured_at: measurement.created_at,
				sensor_ok: measurement.tank_level >= 0,
				distance_cm: distance,
				percent: interpretation.percent,
				percent_min: interpretation.percentMin,
				liters:
					interpretation.liters === null
						? null
						: Math.round(interpretation.liters * 10) / 10,
				too_close: interpretation.tooClose,
				full_volume_liters: Math.round(db.FULL_VOLUME_LITERS * 10) / 10,
			};
		}

		let vacationStatus = null;
		if (vacation.active) {
			const elapsed = db.vacationDaysElapsed(vacation);
			vacationStatus = {
				...vacation,
				days_elapsed: elapsed,
				days_remaining: Math.max(0, vacation.days - elapsed),
				ended: elapsed >= vacation.days,
			};
		}

		res.json({
			tank,
			settings,
			vacation: vacationStatus,
			next_wake: nextWake,
			watering,
			weather,
		});
	} catch (err) {
		res.status(500).json({ error: err.message });
	}
});

app.get("/api/waterings", async (req, res) => {
	try {
		const limit = Math.min(Number(req.query.limit) || 30, 200);
		res.json(await db.listWaterings(limit));
	} catch (err) {
		res.status(500).json({ error: err.message });
	}
});

app.get("/api/device-diagnostics", async (req, res) => {
	try {
		const limit = Math.min(Number(req.query.limit) || 20, 100);
		res.json(await db.listDeviceDiagnostics(limit));
	} catch (err) {
		res.status(500).json({ error: err.message });
	}
});

app.delete("/api/waterings/:id", async (req, res) => {
	try {
		const id = Number(req.params.id);
		if (!Number.isInteger(id)) {
			return res.status(400).json({ error: "id invalide" });
		}
		const deleted = await db.deleteWatering(id);
		if (!deleted) return res.status(404).json({ error: "arrosage introuvable" });
		log(`/api/waterings/${id}  -> entree d'historique supprimee`);
		res.json({ ok: true });
	} catch (err) {
		res.status(500).json({ error: err.message });
	}
});

app.get("/api/measurements", async (req, res) => {
	try {
		const limit = Math.min(Number(req.query.limit) || 50, 500);
		res.json(await db.listMeasurements(limit));
	} catch (err) {
		res.status(500).json({ error: err.message });
	}
});

app.get("/api/settings", async (req, res) => {
	try {
		res.json(await db.getSettings());
	} catch (err) {
		res.status(500).json({ error: err.message });
	}
});

app.put("/api/settings", async (req, res) => {
	try {
		const { daily_watering_seconds, flow_l_per_min } = req.body;
		if (daily_watering_seconds !== undefined) {
			const seconds = Number(daily_watering_seconds);
			if (Number.isNaN(seconds) || seconds < 0 || seconds > 1800) {
				return res
					.status(400)
					.json({ error: "daily_watering_seconds doit etre entre 0 et 1800" });
			}
			await db.setSetting("daily_watering_seconds", Math.round(seconds));
		}
		if (flow_l_per_min !== undefined) {
			const flow = Number(flow_l_per_min);
			if (Number.isNaN(flow) || flow <= 0 || flow > 20) {
				return res
					.status(400)
					.json({ error: "flow_l_per_min doit etre entre 0 et 20" });
			}
			await db.setSetting("flow_l_per_min", flow);
		}
		if (req.body.frost_alert_enabled !== undefined) {
			if (typeof req.body.frost_alert_enabled !== "boolean") {
				return res.status(400).json({ error: "frost_alert_enabled doit etre un booleen" });
			}
			await db.setSetting("frost_alert_enabled", req.body.frost_alert_enabled);
		}
		log(`/api/settings  -> reglages mis a jour : ${JSON.stringify(req.body)}`);
		res.json(await db.getSettings());
	} catch (err) {
		res.status(500).json({ error: err.message });
	}
});

app.get("/api/vacation", async (req, res) => {
	try {
		res.json(await db.getVacation());
	} catch (err) {
		res.status(500).json({ error: err.message });
	}
});

app.put("/api/vacation", async (req, res) => {
	try {
		const { active, days, available_liters, margin_percent } = req.body;

		if (active) {
			const numDays = Number(days);
			const liters = Number(available_liters);
			const margin = margin_percent === undefined ? 5 : Number(margin_percent);
			if (Number.isNaN(numDays) || numDays < 1 || numDays > 60) {
				return res.status(400).json({ error: "days doit etre entre 1 et 60" });
			}
			if (Number.isNaN(liters) || liters <= 0 || liters > 120) {
				return res
					.status(400)
					.json({ error: "available_liters doit etre entre 0 et 120" });
			}
			if (Number.isNaN(margin) || margin < 0 || margin > 50) {
				return res
					.status(400)
					.json({ error: "margin_percent doit etre entre 0 et 50" });
			}
			const vacation = await db.setVacation({
				active: true,
				start_date: db.localDate(),
				days: numDays,
				available_liters: liters,
				margin_percent: margin,
			});
			log(`/api/vacation  -> mode vacances ACTIVE : ${numDays} jours, ${liters} L (marge ${margin} %)`);
			return res.json(vacation);
		}

		const vacation = await db.setVacation({
			active: false,
			start_date: null,
			days: null,
			available_liters: null,
			margin_percent: 5,
		});
		log("/api/vacation  -> mode vacances DESACTIVE");
		res.json(vacation);
	} catch (err) {
		res.status(500).json({ error: err.message });
	}
});

app.put("/api/watering-enabled", async (req, res) => {
	if (req.body?.enabled !== true) {
		return res.status(400).json({ error: "enabled doit etre true" });
	}
	try {
		const watering = await db.enableWatering();
		wateringDisabledInMemory = false;
		log("/api/watering-enabled -> arrosage reactive manuellement depuis l'app.");
		res.json(watering);
	} catch (err) {
		log(`/api/watering-enabled -> ERREUR DB : ${err.message}`);
		res.status(500).json({ error: err.message });
	}
});

app.get("/api/manual-watering", async (req, res) => {
	try {
		const [command, watering] = await Promise.all([
			db.getCommand(),
			db.getWateringStatus(),
		]);
		res.json({
			requested: watering.enabled && Boolean(command.manual_watering_requested),
			requested_seconds: watering.enabled ? command.requested_seconds : null,
			requested_at: watering.enabled ? command.requested_at : null,
			watering_enabled: watering.enabled,
		});
	} catch (err) {
		res.status(500).json({ error: err.message });
	}
});

app.put("/api/manual-watering", async (req, res) => {
	try {
		const seconds = Number(req.body.seconds);
		if (Number.isNaN(seconds) || seconds <= 0 || seconds > 1800) {
			return res
				.status(400)
				.json({ error: "seconds doit etre entre 1 et 1800" });
		}
		const command = await db.requestManualWatering(Math.round(seconds));
		log(`/api/manual-watering  -> arrosage exceptionnel demande : ${Math.round(seconds)}s (sera lance au prochain reveil de sondage, <= 2h)`);
		res.json({
			requested: Boolean(command.manual_watering_requested),
			requested_seconds: command.requested_seconds,
			requested_at: command.requested_at,
		});
	} catch (err) {
		if (err.code === "WATERING_DISABLED") {
			return res.status(409).json({
				error: "L'arrosage est désactivé. Réactivez-le d'abord dans l'application.",
			});
		}
		res.status(500).json({ error: err.message });
	}
});

app.delete("/api/manual-watering", async (req, res) => {
	try {
		await db.cancelManualWatering();
		log("/api/manual-watering  -> demande d'arrosage exceptionnel annulee");
		res.json({ ok: true });
	} catch (err) {
		res.status(500).json({ error: err.message });
	}
});

// --- Sante + application statique ---
app.get("/health", (req, res) => {
	res.json({ status: "ok", uptime_seconds: process.uptime() });
});

const publicDir = path.join(__dirname, "public");
app.use(express.static(publicDir));
// Toute autre route GET non-API renvoie l'app React (routing cote client).
app.get(
	/^\/(?!api|init|water|command|manual-water|next-wake|health).*/,
	(req, res) => {
		res.sendFile(path.join(publicDir, "index.html"), (err) => {
			if (err) res.status(404).json({ error: "application non buildee" });
		});
	},
);

// --- Alerte Telegram si le reveil quotidien n'a pas eu lieu ---
// Le processus Express tourne en continu (maintenu eveille par un ping
// externe sur /health) : un simple setInterval suffit, pas besoin d'un addon
// de type Heroku Scheduler.
async function checkMissedWatering() {
	if (!telegramEnabled) return;
	try {
		const now = new Date();
		const parisTime = new Date(
			now.toLocaleString("en-US", { timeZone: "Europe/Paris" }),
		);
		const graceMinutesPastMidnight =
			WATERING_HOUR * 60 + MISSED_WATERING_GRACE_MINUTES;
		const nowMinutesPastMidnight =
			parisTime.getHours() * 60 + parisTime.getMinutes();
		if (nowMinutesPastMidnight < graceMinutesPastMidnight) return;

		const today = db.localDate();
		const lastAlertDate = await db.getRawSetting("last_missed_alert_date");
		if (lastAlertDate === today) return; // deja alerte aujourd'hui

		if (!(await db.getWateringStatus()).enabled) return;

		const checkedIn = await db.hasWaterCheckinToday();
		if (checkedIn) return;

		const sent = await sendTelegramMessage(
			`⚠️ Aucun arrosage detecte aujourd'hui (attendu vers ${WATERING_HOUR}h). ` +
				"Verifiez que l'ESP32 est bien reveille (LED continue = probleme).",
		);
		if (!sent) {
			log("checkMissedWatering  -> ECHEC envoi Telegram, nouvelle tentative au prochain controle (5 min)");
			return;
		}
		await db.setSetting("last_missed_alert_date", today);
		log("checkMissedWatering  -> alerte Telegram envoyee (arrosage quotidien manque)");
	} catch (err) {
		log(`checkMissedWatering  -> ERREUR : ${err.message}`);
	}
}

// --- Demarrage ---
async function start() {
	if (!process.env.DATABASE_URL) {
		log("ATTENTION : DATABASE_URL non defini, la persistence est desactivee.");
	} else {
		try {
			await db.migrate();
			wateringDisabledInMemory = !(await db.getWateringStatus()).enabled;
			log("Base de donnees prete (migration OK).");
		} catch (err) {
			log(`ERREUR migration DB : ${err.message}`);
		}
	}

	if (!telegramEnabled) {
		log("Notifications Telegram desactivees (TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID absents).");
	} else {
		setInterval(checkMissedWatering, MISSED_WATERING_CHECK_INTERVAL_MS);
	}

	if (!process.env.TELEGRAM_WEBHOOK_URL || !process.env.TELEGRAM_WEBHOOK_SECRET) {
		log(
			"Boutons d’action Telegram pour cuve basse indisponibles : TELEGRAM_WEBHOOK_URL et TELEGRAM_WEBHOOK_SECRET sont requis.",
		);
	} else if (!actionButtonsConfigured) {
		log(
			"Boutons d’action Telegram pour cuve basse indisponibles : TELEGRAM_BOT_TOKEN et TELEGRAM_CHAT_ID sont aussi requis.",
		);
	} else {
		telegramActionButtonsEnabled = await registerWebhook();
		if (telegramActionButtonsEnabled) {
			log("Webhook Telegram enregistre pour les callbacks des boutons de cuve basse.");
		} else {
			log(
				"Boutons d’action Telegram pour cuve basse indisponibles : echec d’enregistrement du webhook.",
			);
		}
	}

	app.listen(PORT, () => {
		log(`Serveur d'arrosage demarre sur http://0.0.0.0:${PORT}`);
	});
}

start();
