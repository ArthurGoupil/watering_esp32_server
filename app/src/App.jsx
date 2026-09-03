import { useEffect, useMemo, useState } from "react";
import {
	getStatus,
	getWaterings,
	getDeviceDiagnostics,
	deleteWatering,
	updateSettings,
	updateVacation,
	getManualWatering,
	requestManualWatering,
	cancelManualWatering,
} from "./api.js";

const formatDate = (iso) =>
	new Date(iso).toLocaleDateString("fr-FR", {
		weekday: "short",
		day: "numeric",
		month: "short",
	});

const formatTime = (iso) =>
	new Date(iso).toLocaleTimeString("fr-FR", {
		hour: "2-digit",
		minute: "2-digit",
	});

const formatDuration = (seconds) => {
	if (seconds < 60) return `${seconds} s`;
	const min = Math.floor(seconds / 60);
	const sec = seconds % 60;
	return sec === 0 ? `${min} min` : `${min} min ${sec} s`;
};

/* --- Bandeau prochain réveil de l'ESP32 --- */
function NextWakeInfo({ nextWake }) {
	if (!nextWake) return null;

	const at = new Date(nextWake.at);
	const label = nextWake.full_cycle
		? "arrosage quotidien"
		: "sondage (arrosage exceptionnel éventuel)";

	return (
		<p className="muted small next-wake">
			📡 Prochain réveil de l’ESP32 : {formatDate(at)} à {formatTime(at)} (
			{label})
		</p>
	);
}

/* --- Jauge de cuve (SVG) --- */
function TankGauge({ tank }) {
	if (!tank) {
		return (
			<div className="card tank-card">
				<p className="muted">Aucune mesure reçue pour l’instant.</p>
			</div>
		);
	}

	const sensorFailed = !tank.sensor_ok || tank.distance_cm === null;
	const percent = sensorFailed ? 0 : tank.percent;
	const tooClose = tank.too_close && !sensorFailed;
	const confirmedPercent = tooClose ? tank.percent_min : percent;
	const confirmedFillHeight = 132 * (confirmedPercent / 100);
	const possibleFillHeight = tooClose ? 132 - confirmedFillHeight : 0;
	const confirmedWaterTop = 146 - confirmedFillHeight;

	return (
		<div className="card tank-card">
			<div className="tank-visual">
				<svg viewBox="0 0 120 160" className="tank-svg">
					<defs>
						<linearGradient id="water" x1="0" y1="0" x2="0" y2="1">
							<stop offset="0%" stopColor="#38bdf8" />
							<stop offset="100%" stopColor="#0284c7" />
						</linearGradient>
						<linearGradient id="possible-water" x1="0" y1="0" x2="0" y2="1">
							<stop offset="0%" stopColor="#38bdf8" stopOpacity="0.1" />
							<stop offset="100%" stopColor="#38bdf8" stopOpacity="0.55" />
						</linearGradient>
						<clipPath id="tankShape">
							<path d="M 20 14 L 100 14 L 91 146 L 29 146 Z" />
						</clipPath>
					</defs>
					<path
						d="M 20 14 L 100 14 L 91 146 L 29 146 Z"
						className="tank-outline"
					/>
					<g clipPath="url(#tankShape)">
						{tooClose && (
							<rect
								x="0"
								y="14"
								width="120"
								height={possibleFillHeight}
								fill="url(#possible-water)"
								className="tank-possible-water"
							/>
						)}
						<rect
							x="0"
							y={confirmedWaterTop}
							width="120"
							height={confirmedFillHeight}
							fill="url(#water)"
							className="tank-water"
						/>
						{tooClose && (
							<line
								x1="20"
								x2="100"
								y1={confirmedWaterTop}
								y2={confirmedWaterTop}
								className="tank-minimum-level"
							/>
						)}
					</g>
				</svg>
				<div className="tank-numbers">
					{sensorFailed ? (
						<>
							<span className="tank-percent error">--</span>
							<span className="tank-liters error">capteur en panne</span>
						</>
					) : tooClose ? (
						<>
							<span className="tank-percent">≥ {tank.percent_min} %</span>
							<span className="tank-liters">
								≥ {Math.round((tank.percent_min / 100) * tank.full_volume_liters)}{" "}
								L / {tank.full_volume_liters} L
							</span>
						</>
					) : (
						<>
							<span className="tank-percent">{percent} %</span>
							<span className="tank-liters">
								≈ {tank.liters} L / {tank.full_volume_liters} L
							</span>
						</>
					)}
				</div>
			</div>
			{tooClose && (
				<p className="notice">
					💧 Cuve quasi pleine : le niveau est au-dessus de la zone de mesure
					fiable du capteur
				</p>
			)}
			<p className="muted small">
				Dernière mesure : {formatDate(tank.measured_at)} à{" "}
				{formatTime(tank.measured_at)}
				{!sensorFailed && ` · distance ${tank.distance_cm} cm`}
			</p>
		</div>
	);
}

/* --- Réglage de la durée quotidienne --- */
function WateringSettings({ settings, onSaved }) {
	const [minutes, setMinutes] = useState(
		Math.round(settings.daily_watering_seconds / 60),
	);
	const [saving, setSaving] = useState(false);
	const [saved, setSaved] = useState(false);

	const liters = useMemo(
		() => Math.round(minutes * settings.flow_l_per_min * 10) / 10,
		[minutes, settings.flow_l_per_min],
	);

	const save = async () => {
		setSaving(true);
		try {
			await updateSettings({ daily_watering_seconds: minutes * 60 });
			setSaved(true);
			setTimeout(() => setSaved(false), 2000);
			onSaved();
		} catch (err) {
			alert(err.message);
		} finally {
			setSaving(false);
		}
	};

	return (
		<div className="card">
			<h2>Arrosage quotidien</h2>
			<div className="slider-row">
				<input
					type="range"
					min="0"
					max="30"
					value={minutes}
					onChange={(e) => setMinutes(Number(e.target.value))}
				/>
				<span className="slider-value">{minutes} min</span>
			</div>
			<p className="muted">
				≈ <strong>{liters} L</strong> par jour (débit{" "}
				{settings.flow_l_per_min} L/min)
			</p>
			<button onClick={save} disabled={saving}>
				{saved ? "✓ Enregistré" : saving ? "…" : "Enregistrer"}
			</button>
		</div>
	);
}

/* --- Mode vacances --- */
function VacationCard({ vacation, flow, onSaved }) {
	const active = vacation?.active;
	const [days, setDays] = useState(vacation?.days ?? 14);
	const [liters, setLiters] = useState(vacation?.available_liters ?? 100);
	const [busy, setBusy] = useState(false);

	const margin = vacation?.margin_percent ?? 5;
	const perDay = Math.round(((liters * (1 - margin / 100)) / days) * 10) / 10;
	const perDayMinutes = Math.round((perDay / flow) * 10) / 10;

	const toggle = async () => {
		setBusy(true);
		try {
			if (active) {
				await updateVacation({ active: false });
			} else {
				await updateVacation({
					active: true,
					days,
					available_liters: liters,
					margin_percent: margin,
				});
			}
			onSaved();
		} catch (err) {
			alert(err.message);
		} finally {
			setBusy(false);
		}
	};

	return (
		<div className={`card ${active ? "vacation-active" : ""}`}>
			<h2>Mode vacances {active && <span className="badge">actif</span>}</h2>

			{active ? (
				<>
					<p>
						Jour <strong>{Math.min(vacation.days_elapsed + 1, vacation.days)}</strong> /{" "}
						{vacation.days} ·{" "}
						{vacation.ended ? (
							<strong className="error">
								période terminée, arrosage arrêté
							</strong>
						) : (
							<>
								reste{" "}
								<strong>{vacation.days_remaining} jour(s)</strong>
							</>
						)}
					</p>
					<p className="muted">
						{vacation.available_liters} L répartis sur {vacation.days} jours
						(marge {vacation.margin_percent} %)
					</p>
					<button onClick={toggle} disabled={busy} className="secondary">
						Désactiver et revenir au réglage quotidien
					</button>
				</>
			) : (
				<>
					<label>
						Durée des vacances
						<div className="input-row">
							<input
								type="number"
								min="1"
								max="60"
								value={days}
								onChange={(e) => setDays(Number(e.target.value))}
							/>
							<span>jours</span>
						</div>
					</label>
					<label>
						Eau disponible dans la cuve
						<div className="input-row">
							<input
								type="number"
								min="1"
								max="120"
								value={liters}
								onChange={(e) => setLiters(Number(e.target.value))}
							/>
							<span>litres</span>
						</div>
					</label>
					<p className="muted">
						→ ≈ <strong>{perDay} L/jour</strong> ({perDayMinutes} min
						d’arrosage), marge de sécurité {margin} %.
						<br />À la fin, l’arrosage <strong>s’arrête</strong> jusqu’à
						désactivation manuelle.
					</p>
					<button onClick={toggle} disabled={busy}>
						Activer le mode vacances
					</button>
				</>
			)}
		</div>
	);
}

/* --- Arrosage exceptionnel (déclenché à distance) --- */
function ManualWateringCard({ manualWatering, onSaved }) {
	const [seconds, setSeconds] = useState(120);
	const [busy, setBusy] = useState(false);

	const pending = manualWatering?.requested;

	const trigger = async () => {
		setBusy(true);
		try {
			await requestManualWatering(seconds);
			onSaved();
		} catch (err) {
			alert(err.message);
		} finally {
			setBusy(false);
		}
	};

	const cancel = async () => {
		setBusy(true);
		try {
			await cancelManualWatering();
			onSaved();
		} catch (err) {
			alert(err.message);
		} finally {
			setBusy(false);
		}
	};

	return (
		<div className={`card ${pending ? "vacation-active" : ""}`}>
			<h2>
				Arrosage exceptionnel{" "}
				{pending && <span className="badge">en attente</span>}
			</h2>
			{pending ? (
				<>
					<p>
						Demande de <strong>{formatDuration(manualWatering.requested_seconds)}</strong>{" "}
						enregistrée.
					</p>
					<p className="muted">
						Sera lancé au prochain réveil de sondage de l’ESP32 (au plus tard
						2h après la demande, dès qu’il se reconnecte au WiFi). Une
						notification Telegram confirmera le démarrage puis la fin.
					</p>
					<button onClick={cancel} disabled={busy} className="secondary">
						{busy ? "…" : "Annuler la demande"}
					</button>
				</>
			) : (
				<>
					<div className="slider-row">
						<input
							type="range"
							min="10"
							max="1800"
							step="10"
							value={seconds}
							onChange={(e) => setSeconds(Number(e.target.value))}
						/>
						<span className="slider-value">{formatDuration(seconds)}</span>
					</div>
					<p className="muted">
						Déclenche un arrosage ponctuel, sans désactiver la mise en veille
						de l’ESP32 (économie de batterie conservée). Il sera exécuté au
						prochain réveil de sondage, dans un délai maximum de 2h.
					</p>
					<button onClick={trigger} disabled={busy}>
						{busy ? "…" : "Arroser maintenant"}
					</button>
				</>
			)}
		</div>
	);
}

/* --- Journaux de diagnostic ESP32 --- */
function DiagnosticsCard({ diagnostics }) {
	const [expandedId, setExpandedId] = useState(null);

	if (diagnostics.length === 0) {
		return (
			<div className="card">
				<h2>Diagnostic ESP32</h2>
				<p className="muted">
					Aucun journal reçu pour l’instant. Les journaux sont envoyés au
					prochain réveil WiFi après le flash du firmware de diagnostic.
				</p>
			</div>
		);
	}

	return (
		<div className="card">
			<h2>Diagnostic ESP32</h2>
			<p className="muted small">
				Derniers événements conservés par la carte avant son réveil.
			</p>
			<ul className="diagnostics">
				{diagnostics.map((diagnostic) => (
					<li key={diagnostic.id}>
						<button
							className="history-row"
							onClick={() =>
								setExpandedId(
									expandedId === diagnostic.id ? null : diagnostic.id,
								)
							}
						>
							<span className="history-date">
								{formatDate(diagnostic.created_at)}
							</span>
							<span className="history-main">
								Reset : {diagnostic.reset_reason}
								{diagnostic.persistent_checkpoint &&
									` · ${diagnostic.persistent_checkpoint}`}
							</span>
							<span className="history-chevron">
								{expandedId === diagnostic.id ? "▾" : "▸"}
							</span>
						</button>
						{expandedId === diagnostic.id && (
							<div className="history-detail">
								<p>Reçu à : {formatTime(diagnostic.created_at)}</p>
								<p>
									Dernier jalon persistant :{" "}
									{diagnostic.persistent_checkpoint ?? "—"}
								</p>
								<ol className="diagnostic-events">
									{diagnostic.events.map((event, index) => (
										<li key={`${diagnostic.id}-${index}`}>{event}</li>
									))}
								</ol>
							</div>
						)}
					</li>
				))}
			</ul>
		</div>
	);
}

/* --- Historique des arrosages --- */
function History({ waterings, onDeleted }) {
	const [expandedId, setExpandedId] = useState(null);
	const [deletingId, setDeletingId] = useState(null);

	const remove = async (w) => {
		if (
			!window.confirm(
				`Supprimer l'arrosage du ${formatDate(w.created_at)} (${formatDuration(w.requested_seconds)}) ?`,
			)
		) {
			return;
		}
		setDeletingId(w.id);
		try {
			await deleteWatering(w.id);
			setExpandedId(null);
			onDeleted();
		} catch (err) {
			alert(err.message);
		} finally {
			setDeletingId(null);
		}
	};

	if (waterings.length === 0) {
		return (
			<div className="card">
				<h2>Historique</h2>
				<p className="muted">Aucun arrosage enregistré pour l’instant.</p>
			</div>
		);
	}

	const sourceLabel = {
		daily: "quotidien",
		vacation: "vacances",
		vacation_ended: "vacances terminées",
		fallback: "secours",
		manual: "exceptionnel",
	};

	return (
		<div className="card">
			<h2>Historique</h2>
			<ul className="history">
				{waterings.map((w) => (
					<li key={w.id}>
						<button
							className="history-row"
							onClick={() =>
								setExpandedId(expandedId === w.id ? null : w.id)
							}
						>
							<span className="history-date">{formatDate(w.created_at)}</span>
							<span className="history-main">
								{formatDuration(w.requested_seconds)}
								{w.estimated_liters_flow !== null &&
									` · ≈ ${w.estimated_liters_flow} L`}
							</span>
							<span className="history-chevron">
								{expandedId === w.id ? "▾" : "▸"}
							</span>
						</button>
						{expandedId === w.id && (
							<div className="history-detail">
								<p>Heure : {formatTime(w.created_at)}</p>
								<p>Source : {sourceLabel[w.source] ?? w.source}</p>
								{w.tank_percent_before !== null && (
									<p>
										Cuve avant arrosage : {w.tank_percent_before} % (≈{" "}
										{w.tank_liters_before} L, distance{" "}
										{w.distance_before_cm} cm)
									</p>
								)}
								<p>
									Eau estimée (débit) :{" "}
									{w.estimated_liters_flow !== null
										? `${w.estimated_liters_flow} L`
										: "—"}
								</p>
								<p>
									Eau mesurée (capteur) :{" "}
									{w.estimated_liters_sensor !== null
										? `${w.estimated_liters_sensor} L`
										: "non estimable"}
								</p>
								<button
									className="danger"
									onClick={() => remove(w)}
									disabled={deletingId === w.id}
								>
									{deletingId === w.id ? "…" : "Supprimer cette entrée"}
								</button>
							</div>
						)}
					</li>
				))}
			</ul>
		</div>
	);
}

/* --- Application --- */
export default function App() {
	const [status, setStatus] = useState(null);
	const [waterings, setWaterings] = useState([]);
	const [diagnostics, setDiagnostics] = useState([]);
	const [manualWatering, setManualWatering] = useState(null);
	const [error, setError] = useState(null);

	const refresh = async () => {
		try {
			const [s, w, d, m] = await Promise.all([
				getStatus(),
				getWaterings(),
				getDeviceDiagnostics(),
				getManualWatering(),
			]);
			setStatus(s);
			setWaterings(w);
			setDiagnostics(d);
			setManualWatering(m);
			setError(null);
		} catch (err) {
			setError(err.message);
		}
	};

	useEffect(() => {
		refresh();
		const interval = setInterval(refresh, 60000);
		return () => clearInterval(interval);
	}, []);

	if (error && !status) {
		return (
			<main className="app">
				<h1>💧 Arrosage</h1>
				<div className="card">
					<p className="error">Erreur : {error}</p>
					<button onClick={refresh}>Réessayer</button>
				</div>
			</main>
		);
	}

	if (!status) {
		return (
			<main className="app">
				<h1>💧 Arrosage</h1>
				<p className="muted">Chargement…</p>
			</main>
		);
	}

	return (
		<main className="app">
			<h1>💧 Arrosage</h1>
			<NextWakeInfo nextWake={status.next_wake} />
			<TankGauge tank={status.tank} />
			<ManualWateringCard manualWatering={manualWatering} onSaved={refresh} />
			<WateringSettings settings={status.settings} onSaved={refresh} />
			<VacationCard
				vacation={status.vacation ?? { active: false }}
				flow={status.settings.flow_l_per_min}
				onSaved={refresh}
			/>
			<History waterings={waterings} onDeleted={refresh} />
			<DiagnosticsCard diagnostics={diagnostics} />
			<p className="muted small footer">
				Arrosage automatique chaque matin à 8h · mise à jour auto
			</p>
		</main>
	);
}
