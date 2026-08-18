/*
 * ============================================================================
 *  Couche base de donnees (PostgreSQL / Neon)
 * ============================================================================
 *  - Pool de connexions pg
 *  - Migration automatique au demarrage (CREATE TABLE IF NOT EXISTS)
 *  - Helpers metier : mesures, arrosages, reglages, mode vacances
 * ============================================================================
 */

const { Pool } = require("pg");

const pool = new Pool({
	connectionString: process.env.DATABASE_URL,
	// Neon exige SSL ; un Postgres local (tests) ne le supporte pas.
	ssl: /localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL || "")
		? false
		: { rejectUnauthorized: false },
	max: 3,
});

// --- Geometrie de la cuve (cone tronque) ---
const TANK_HEIGHT_CM = 78;
const TANK_RADIUS_BOTTOM_CM = 20.5;
const TANK_RADIUS_TOP_CM = 27;
// Distance capteur -> eau consideree comme "cuve pleine" (100 %).
const FULL_DISTANCE_CM = 10;
// En dessous de cette distance, la mesure ultrason n'est plus fiable
// (zone morte du JSN-SR04T ~25 cm).
const TOO_CLOSE_CM = 25;

// Volume d'eau (litres) pour une hauteur d'eau donnee (cm) dans le cone tronque.
function volumeLitersForWaterHeight(waterHeightCm) {
	const h = Math.max(0, Math.min(TANK_HEIGHT_CM, waterHeightCm));
	const r1 = TANK_RADIUS_BOTTOM_CM;
	const r2 =
		TANK_RADIUS_BOTTOM_CM +
		((TANK_RADIUS_TOP_CM - TANK_RADIUS_BOTTOM_CM) * h) / TANK_HEIGHT_CM;
	const volumeCm3 = (Math.PI * h * (r1 * r1 + r1 * r2 + r2 * r2)) / 3;
	return volumeCm3 / 1000;
}

// Volume (litres) a partir de la distance capteur -> eau (cm).
function volumeLitersForDistance(distanceCm) {
	return volumeLitersForWaterHeight(TANK_HEIGHT_CM - distanceCm);
}

const FULL_VOLUME_LITERS = volumeLitersForDistance(FULL_DISTANCE_CM);

// Interpretation complete d'une distance mesuree.
// En dessous de TOO_CLOSE_CM la mesure n'est pas fiable : on renvoie aussi
// percentMin, le niveau minimum garanti (celui qu'aurait l'eau a TOO_CLOSE_CM).
function interpretDistance(distanceCm) {
	if (distanceCm === null || distanceCm < 0) {
		return { valid: false, tooClose: false, liters: null, percent: null, percentMin: null };
	}
	const tooClose = distanceCm < TOO_CLOSE_CM;
	const liters = volumeLitersForDistance(distanceCm);
	const percent = Math.max(
		0,
		Math.min(100, Math.round((liters / FULL_VOLUME_LITERS) * 100)),
	);
	const percentMin = tooClose
		? Math.min(
				100,
				Math.round(
					(volumeLitersForDistance(TOO_CLOSE_CM) / FULL_VOLUME_LITERS) * 100,
				),
			)
		: null;
	return { valid: true, tooClose, liters, percent, percentMin };
}

// Date locale (Europe/Paris) au format YYYY-MM-DD.
function localDate(date = new Date()) {
	return date.toLocaleDateString("fr-CA", { timeZone: "Europe/Paris" });
}

// --- Migration ---
async function migrate() {
	await pool.query(`
		CREATE TABLE IF NOT EXISTS measurements (
			id SERIAL PRIMARY KEY,
			created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
			local_date DATE NOT NULL,
			endpoint TEXT NOT NULL,
			tank_level INTEGER,
			raw_distance_cm REAL,
			valid_samples INTEGER,
			read_attempts INTEGER,
			attempted_samples INTEGER,
			timeout_samples INTEGER,
			out_of_range_samples INTEGER,
			echo_idle_high_samples INTEGER
		);

		CREATE TABLE IF NOT EXISTS waterings (
			id SERIAL PRIMARY KEY,
			created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
			local_date DATE NOT NULL,
			requested_seconds INTEGER NOT NULL,
			source TEXT NOT NULL DEFAULT 'daily',
			distance_before_cm REAL,
			tank_percent_before INTEGER,
			tank_liters_before REAL,
			estimated_liters_flow REAL,
			estimated_liters_sensor REAL,
			measurement_id INTEGER REFERENCES measurements(id)
		);

		CREATE TABLE IF NOT EXISTS settings (
			key TEXT PRIMARY KEY,
			value TEXT NOT NULL
		);

		CREATE TABLE IF NOT EXISTS vacation (
			id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
			active BOOLEAN NOT NULL DEFAULT false,
			start_date DATE,
			days INTEGER,
			available_liters REAL,
			margin_percent INTEGER NOT NULL DEFAULT 5
		);

		INSERT INTO settings (key, value)
			VALUES ('daily_watering_seconds', '500'), ('flow_l_per_min', '1.26')
			ON CONFLICT (key) DO NOTHING;

		INSERT INTO vacation (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

		CREATE TABLE IF NOT EXISTS commands (
			id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
			manual_watering_requested BOOLEAN NOT NULL DEFAULT false,
			requested_seconds INTEGER,
			requested_at TIMESTAMPTZ,
			request_id INTEGER NOT NULL DEFAULT 0
		);

		INSERT INTO commands (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

		ALTER TABLE commands ADD COLUMN IF NOT EXISTS request_id INTEGER NOT NULL DEFAULT 0;
	`);
}

// --- Reglages ---
async function getSettings() {
	const { rows } = await pool.query("SELECT key, value FROM settings");
	const map = Object.fromEntries(rows.map((r) => [r.key, r.value]));
	return {
		daily_watering_seconds: Number(map.daily_watering_seconds ?? 500),
		flow_l_per_min: Number(map.flow_l_per_min ?? 1.26),
	};
}

async function setSetting(key, value) {
	await pool.query(
		`INSERT INTO settings (key, value) VALUES ($1, $2)
		 ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
		[key, String(value)],
	);
}

// Lecture brute d'un reglage cle/valeur non modelise dans getSettings()
// (ex. flags internes comme "derniere date d'alerte Telegram envoyee").
async function getRawSetting(key) {
	const { rows } = await pool.query(
		"SELECT value FROM settings WHERE key = $1",
		[key],
	);
	return rows[0]?.value ?? null;
}

// --- Prochain reveil de l'ESP32 (rapporte par le firmware a chaque
// endormissement, pour affichage dans l'app) ---
async function setNextWake(seconds, fullCycle) {
	const at = new Date(Date.now() + seconds * 1000).toISOString();
	await setSetting("next_wake_at", at);
	await setSetting("next_wake_full_cycle", fullCycle ? "true" : "false");
}

async function getNextWake() {
	const at = await getRawSetting("next_wake_at");
	if (!at) return null;
	return {
		at,
		full_cycle: (await getRawSetting("next_wake_full_cycle")) === "true",
	};
}

// --- Mode vacances ---
async function getVacation() {
	const { rows } = await pool.query("SELECT * FROM vacation WHERE id = 1");
	return rows[0];
}

async function setVacation({ active, start_date, days, available_liters, margin_percent }) {
	await pool.query(
		`UPDATE vacation SET active = $1, start_date = $2, days = $3,
		 available_liters = $4, margin_percent = $5 WHERE id = 1`,
		[active, start_date, days, available_liters, margin_percent],
	);
	return getVacation();
}

// Nombre de jours ecoules depuis le debut des vacances (0 = premier jour).
function vacationDaysElapsed(vacation, today = localDate()) {
	const start = new Date(`${vacation.start_date instanceof Date ? localDate(vacation.start_date) : vacation.start_date}T00:00:00`);
	const now = new Date(`${today}T00:00:00`);
	return Math.round((now - start) / 86400000);
}

/*
 * Duree d'arrosage du jour (secondes) + source.
 * - Vacances actives et periode en cours : quantite disponible (moins la
 *   marge) repartie equitablement sur le nombre de jours.
 * - Vacances actives mais periode terminee : 0 s (arret jusqu'a desactivation
 *   manuelle, choix utilisateur).
 * - Sinon : duree quotidienne definie dans les reglages.
 */
async function computeWateringSeconds() {
	const [settings, vacation] = await Promise.all([getSettings(), getVacation()]);

	if (vacation.active && vacation.start_date && vacation.days > 0) {
		const elapsed = vacationDaysElapsed(vacation);
		if (elapsed >= vacation.days) {
			return { seconds: 0, source: "vacation_ended" };
		}
		if (elapsed >= 0) {
			const usable =
				vacation.available_liters * (1 - vacation.margin_percent / 100);
			const litersPerDay = usable / vacation.days;
			const seconds = Math.round((litersPerDay / settings.flow_l_per_min) * 60);
			return { seconds, source: "vacation", litersPerDay };
		}
		// Vacances planifiees dans le futur : arrosage normal en attendant.
	}

	return { seconds: settings.daily_watering_seconds, source: "daily" };
}

// --- Commande d'arrosage manuel (declenche depuis l'app, execute par l'ESP32
// au prochain reveil de sondage, au plus tard CHECKIN_INTERVAL_MINUTES apres) ---
async function getCommand() {
	const { rows } = await pool.query("SELECT * FROM commands WHERE id = 1");
	return rows[0];
}

async function requestManualWatering(seconds) {
	await pool.query(
		`UPDATE commands SET manual_watering_requested = true,
		 requested_seconds = $1, requested_at = now(),
		 request_id = request_id + 1 WHERE id = 1`,
		[seconds],
	);
	return getCommand();
}

async function cancelManualWatering() {
	await pool.query(
		`UPDATE commands SET manual_watering_requested = false,
		 requested_seconds = NULL, requested_at = NULL WHERE id = 1`,
	);
	return getCommand();
}

// Ne consomme la commande QUE si request_id correspond encore a celle recue
// par l'ESP32 au moment du sondage : evite qu'un arrosage annule/remplace
// entre-temps ne soit quand meme execute (ou qu'une commande plus recente ne
// soit effacee par erreur). Retourne null si la commande a change depuis.
//
// La consommation de la commande ET l'insertion de l'historique sont faites
// dans UNE SEULE transaction : si l'une des deux echoue, l'autre est annulee
// (rollback), pour ne jamais se retrouver avec une commande "consommee" sans
// arrosage enregistre (ce qui aurait fait perdre la demande sans arrosage
// reel).
async function recordManualWatering(requestId, seconds, measurementId, distanceCm) {
	const client = await pool.connect();
	try {
		await client.query("BEGIN");

		const consumeResult = await client.query(
			`UPDATE commands SET manual_watering_requested = false
			 WHERE id = 1 AND request_id = $1 AND manual_watering_requested = true
			 RETURNING *`,
			[requestId],
		);
		if (consumeResult.rows.length === 0) {
			await client.query("ROLLBACK");
			return { cancelled: true };
		}

		const settingsResult = await client.query(
			"SELECT key, value FROM settings",
		);
		const map = Object.fromEntries(
			settingsResult.rows.map((r) => [r.key, r.value]),
		);
		const flow = Number(map.flow_l_per_min ?? 1.26);
		const interpretation = interpretDistance(distanceCm);

		await client.query(
			`INSERT INTO waterings
			 (local_date, requested_seconds, source, distance_before_cm,
			  tank_percent_before, tank_liters_before, estimated_liters_flow,
			  measurement_id)
			 VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
			[
				localDate(),
				seconds,
				"manual",
				distanceCm !== null && distanceCm >= 0 ? distanceCm : null,
				interpretation.percent,
				interpretation.liters === null
					? null
					: Math.round(interpretation.liters * 10) / 10,
				Math.round((seconds / 60) * flow * 10) / 10,
				measurementId,
			],
		);

		await client.query("COMMIT");
		return { cancelled: false };
	} catch (err) {
		await client.query("ROLLBACK");
		throw err;
	} finally {
		client.release();
	}
}

// --- Mesures ---
async function insertMeasurement(endpoint, m) {
	const { rows } = await pool.query(
		`INSERT INTO measurements
		 (local_date, endpoint, tank_level, raw_distance_cm, valid_samples,
		  read_attempts, attempted_samples, timeout_samples,
		  out_of_range_samples, echo_idle_high_samples)
		 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
		[
			localDate(),
			endpoint,
			m.tankLevel,
			m.rawDistanceCm,
			m.validSamples,
			m.readAttempts,
			m.attemptedSamples,
			m.timeoutSamples,
			m.outOfRangeSamples,
			m.echoIdleHighSamples,
		],
	);
	return rows[0].id;
}

// Derniere mesure prise en compte par l'app : la plus recente encore liee a
// une entree d'historique d'arrosage. La jauge est ainsi toujours coherente
// avec l'historique (suppression comprise), et les mesures /init ou
// orphelines sont ignorees.
async function latestMeasurement() {
	const { rows } = await pool.query(
		`SELECT m.* FROM measurements m
		 JOIN waterings w ON w.measurement_id = m.id
		 ORDER BY m.created_at DESC LIMIT 1`,
	);
	return rows[0] ?? null;
}

// --- Arrosages ---
async function insertWatering(w) {
	const { rows } = await pool.query(
		`INSERT INTO waterings
		 (local_date, requested_seconds, source, distance_before_cm,
		  tank_percent_before, tank_liters_before, estimated_liters_flow,
		  measurement_id)
		 VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
		[
			localDate(),
			w.requestedSeconds,
			w.source,
			w.distanceBeforeCm,
			w.tankPercentBefore,
			w.tankLitersBefore,
			w.estimatedLitersFlow,
			w.measurementId,
		],
	);
	return rows[0].id;
}

// Atomically records the one allowed automatic watering for a local day.
// Manual waterings intentionally do not participate in this rule. A
// transaction-scoped Postgres advisory lock prevents two near-simultaneous
// /water calls from both seeing "no watering yet" and starting the pump.
async function recordAutomaticWateringOnceToday(w) {
	const client = await pool.connect();
	try {
		await client.query("BEGIN");
		await client.query("SELECT pg_advisory_xact_lock($1)", [5172026]);

		const day = localDate();
		const { rows: existing } = await client.query(
			`SELECT id FROM waterings
			 WHERE local_date = $1 AND source <> 'manual'
			 LIMIT 1`,
			[day],
		);
		if (existing.length > 0) {
			await client.query("COMMIT");
			return { created: false, id: existing[0].id };
		}

		const { rows } = await client.query(
			`INSERT INTO waterings
			 (local_date, requested_seconds, source, distance_before_cm,
			  tank_percent_before, tank_liters_before, estimated_liters_flow,
			  measurement_id)
			 VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
			[
				day,
				w.requestedSeconds,
				w.source,
				w.distanceBeforeCm,
				w.tankPercentBefore,
				w.tankLitersBefore,
				w.estimatedLitersFlow,
				w.measurementId,
			],
		);
		await client.query("COMMIT");
		return { created: true, id: rows[0].id };
	} catch (err) {
		await client.query("ROLLBACK");
		throw err;
	} finally {
		client.release();
	}
}

/*
 * Estimation "capteur" de l'arrosage precedent : difference de volume entre
 * la mesure d'avant-arrosage de la veille et celle d'aujourd'hui. On ne
 * calcule rien si l'une des deux distances est absente ou trop proche du
 * capteur (< TOO_CLOSE_CM) pour etre fiable.
 */
async function estimatePreviousWateringFromSensor(todayDistanceCm) {
	if (todayDistanceCm === null || todayDistanceCm < TOO_CLOSE_CM) return;

	const { rows } = await pool.query(
		`SELECT id, distance_before_cm FROM waterings
		 WHERE estimated_liters_sensor IS NULL
		   AND requested_seconds > 0
		   AND local_date < $1
		 ORDER BY created_at DESC LIMIT 1`,
		[localDate()],
	);
	const previous = rows[0];
	if (!previous || previous.distance_before_cm === null) return;
	if (previous.distance_before_cm < TOO_CLOSE_CM) return;

	const liters =
		volumeLitersForDistance(previous.distance_before_cm) -
		volumeLitersForDistance(todayDistanceCm);
	if (liters <= 0) return; // niveau monte (remplissage) : estimation impossible

	await pool.query(
		"UPDATE waterings SET estimated_liters_sensor = $1 WHERE id = $2",
		[Math.round(liters * 10) / 10, previous.id],
	);
}

async function listWaterings(limit = 30) {
	const { rows } = await pool.query(
		"SELECT * FROM waterings ORDER BY created_at DESC LIMIT $1",
		[limit],
	);
	return rows;
}

// Supprime un arrosage ET sa mesure associee : la jauge de la cuve (basee sur
// la derniere mesure) retombe ainsi sur la mesure precedente.
async function deleteWatering(id) {
	const { rows } = await pool.query(
		"DELETE FROM waterings WHERE id = $1 RETURNING measurement_id",
		[id],
	);
	if (rows.length === 0) return false;
	if (rows[0].measurement_id !== null) {
		await pool.query("DELETE FROM measurements WHERE id = $1", [
			rows[0].measurement_id,
		]);
	}
	return true;
}

async function listMeasurements(limit = 50) {
	const { rows } = await pool.query(
		"SELECT * FROM measurements ORDER BY created_at DESC LIMIT $1",
		[limit],
	);
	return rows;
}

// Un cycle quotidien complet appelle toujours /water (meme si la duree
// renvoyee est 0s, ex. fin de vacances) : sa presence suffit a dire que
// l'ESP32 s'est bien reveille et a communique aujourd'hui.
async function hasWaterCheckinToday() {
	const { rows } = await pool.query(
		"SELECT 1 FROM measurements WHERE endpoint = '/water' AND local_date = $1 LIMIT 1",
		[localDate()],
	);
	return rows.length > 0;
}

module.exports = {
	pool,
	migrate,
	getSettings,
	setSetting,
	getRawSetting,
	setNextWake,
	getNextWake,
	getVacation,
	setVacation,
	vacationDaysElapsed,
	computeWateringSeconds,
	insertMeasurement,
	latestMeasurement,
	insertWatering,
	recordAutomaticWateringOnceToday,
	deleteWatering,
	estimatePreviousWateringFromSensor,
	listWaterings,
	listMeasurements,
	hasWaterCheckinToday,
	getCommand,
	requestManualWatering,
	cancelManualWatering,
	recordManualWatering,
	interpretDistance,
	volumeLitersForDistance,
	localDate,
	FULL_VOLUME_LITERS,
	TOO_CLOSE_CM,
};
