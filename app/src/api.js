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
