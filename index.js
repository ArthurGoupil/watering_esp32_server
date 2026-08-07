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
const db = require("./db");

const PORT = process.env.PORT || 3000;
const FALLBACK_WATERING_SECONDS = 500;

const app = express();
app.use(express.json());

function log(...args) {
	console.log(`[${new Date().toISOString()}]`, ...args);
}

// --- Lecture des parametres envoyes par l'ESP32 ---
function parseEsp32Query(query) {
	const num = (name) => {
		const raw = query[name];
		if (raw === undefined || raw === null || raw === "") return null;
		const value = Number(raw);
		return Number.isNaN(value) ? null : value;
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
	let seconds = FALLBACK_WATERING_SECONDS;
	let source = "fallback";
	try {
		const decision = await db.computeWateringSeconds();
		seconds = decision.seconds;
		source = decision.source;
	} catch (err) {
		log(`/water  -> ERREUR DB (duree de secours ${FALLBACK_WATERING_SECONDS}s utilisee) : ${err.message}`);
	}

	log(`/water  -> duree d'arrosage renvoyee = ${seconds}s (source : ${source})`);

	// Enregistrement de l'arrosage + estimation capteur de l'arrosage precedent.
	try {
		if (seconds > 0) {
			const settings = await db.getSettings();
			const interpretation = db.interpretDistance(m.rawDistanceCm);
			await db.insertWatering({
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
		}
		if (m.rawDistanceCm !== null && m.rawDistanceCm >= 0) {
			await db.estimatePreviousWateringFromSensor(m.rawDistanceCm);
		}
	} catch (err) {
		log(`/water  -> ERREUR DB (arrosage non enregistre) : ${err.message}`);
	}

	res.json({
		ok: true,
		received_tank_level: m.tankLevel,
		received_raw_distance_cm: m.rawDistanceCm,
		watering_seconds: seconds,
	});
});

// --- API de l'application ---
app.get("/api/status", async (req, res) => {
	try {
		const [measurement, settings, vacation] = await Promise.all([
			db.latestMeasurement(),
			db.getSettings(),
			db.getVacation(),
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

		res.json({ tank, settings, vacation: vacationStatus });
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

// --- Sante + application statique ---
app.get("/health", (req, res) => {
	res.json({ status: "ok", uptime_seconds: process.uptime() });
});

const publicDir = path.join(__dirname, "public");
app.use(express.static(publicDir));
// Toute autre route GET non-API renvoie l'app React (routing cote client).
app.get(/^\/(?!api|init|water|health).*/, (req, res) => {
	res.sendFile(path.join(publicDir, "index.html"), (err) => {
		if (err) res.status(404).json({ error: "application non buildee" });
	});
});

// --- Demarrage ---
async function start() {
	if (!process.env.DATABASE_URL) {
		log("ATTENTION : DATABASE_URL non defini, la persistence est desactivee.");
	} else {
		try {
			await db.migrate();
			log("Base de donnees prete (migration OK).");
		} catch (err) {
			log(`ERREUR migration DB : ${err.message}`);
		}
	}

	app.listen(PORT, () => {
		log(`Serveur d'arrosage demarre sur http://0.0.0.0:${PORT}`);
	});
}

start();
