const jsonHeaders = { "Content-Type": "application/json" };

async function request(url, options) {
	const res = await fetch(url, options);
	if (!res.ok) {
		const body = await res.json().catch(() => ({}));
		throw new Error(body.error || `Erreur HTTP ${res.status}`);
	}
	return res.json();
}

export const getStatus = () => request("/api/status");
export const getWaterings = (limit = 30) =>
	request(`/api/waterings?limit=${limit}`);
export const getDeviceDiagnostics = (limit = 20) =>
	request(`/api/device-diagnostics?limit=${limit}`);
export const deleteWatering = (id) =>
	request(`/api/waterings/${id}`, { method: "DELETE" });
export const updateSettings = (settings) =>
	request("/api/settings", {
		method: "PUT",
		headers: jsonHeaders,
		body: JSON.stringify(settings),
	});
export const updateVacation = (vacation) =>
	request("/api/vacation", {
		method: "PUT",
		headers: jsonHeaders,
		body: JSON.stringify(vacation),
	});
export const getManualWatering = () => request("/api/manual-watering");
export const requestManualWatering = (seconds) =>
	request("/api/manual-watering", {
		method: "PUT",
		headers: jsonHeaders,
		body: JSON.stringify({ seconds }),
	});
export const cancelManualWatering = () =>
	request("/api/manual-watering", { method: "DELETE" });
