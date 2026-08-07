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

// Derniere mesure prise en compte par l'app : uniquement celles du cycle
// d'arrosage (/water). Les mesures /init (diagnostics de redemarrage) sont
// stockees mais ignorees par la jauge.
async function latestMeasurement() {
	const { rows } = await pool.query(
		"SELECT * FROM measurements WHERE endpoint = '/water' ORDER BY created_at DESC LIMIT 1",
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

module.exports = {
	pool,
	migrate,
	getSettings,
	setSetting,
	getVacation,
	setVacation,
	vacationDaysElapsed,
	computeWateringSeconds,
	insertMeasurement,
	latestMeasurement,
	insertWatering,
	deleteWatering,
	estimatePreviousWateringFromSensor,
	listWaterings,
	listMeasurements,
	interpretDistance,
	volumeLitersForDistance,
	localDate,
	FULL_VOLUME_LITERS,
	TOO_CLOSE_CM,
};
