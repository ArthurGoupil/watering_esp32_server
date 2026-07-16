/*
 * ============================================================================
 *  Serveur de test - Arrosage automatique
 * ============================================================================
 *
 *  Petit serveur HTTP (sans dependance, module "http" natif de Node) qui :
 *    - ecoute sur le port PORT (3000 par defaut)
 *    - repond a  GET /water?tank_level=<pourcentage>
 *    - log chaque appel dans la console avec l'heure et le niveau recu
 *    - renvoie une reponse JSON
 *
 *  Objectif actuel : verifier que l'ESP32 communique bien.
 *
 *  Plus tard : l'endpoint renverra une DUREE d'arrosage (en secondes) que
 *  l'ESP32 devra respecter. Un exemple de logique est deja prepare plus bas
 *  (voir computeWateringSeconds) mais reste desactive pour l'instant.
 *
 *  Lancer :   node server/index.js
 *  ou :       npm start   (depuis le dossier server/)
 * ============================================================================
 */

const http = require("http");
const { URL } = require("url");

const PORT = process.env.PORT || 3000;

// --- Journalisation simple avec horodatage ---
function log(...args) {
  const now = new Date().toISOString();
  console.log(`[${now}]`, ...args);
}

/*
 * Exemple de future logique d'arrosage (DESACTIVE pour l'instant).
 * Renvoie une duree d'arrosage en secondes selon le niveau de la cuve.
 * A activer quand tu voudras piloter la pompe.
 */
function computeWateringSeconds(tankLevel) {
  if (tankLevel < 0) return 0; // capteur en panne -> pas d'arrosage
  if (tankLevel < 15) return 0; // cuve trop basse -> on protege la pompe
  return 30; // valeur d'exemple
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  // Route de sante : utilisee par un cronjob externe pour empecher le dyno
  // Heroku de s'endormir (et pour verifier rapidement que le serveur tourne).
  if (req.method === "GET" && url.pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", uptime_seconds: process.uptime() }));
    return;
  }

  // Page d'accueil : utile pour verifier vite fait dans un navigateur que le
  // serveur (et le tunnel) repondent bien.
  if (req.method === "GET" && url.pathname === "/") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(
      "<h1>Serveur d'arrosage OK</h1>" +
        "<p>Le serveur repond bien.</p>" +
        '<p>Endpoint de test : <a href="/water?tank_level=50">/water?tank_level=50</a></p>'
    );
    return;
  }

  // On ne gere que GET /water
  if (req.method === "GET" && url.pathname === "/water") {
    const raw = url.searchParams.get("tank_level");
    const tankLevel = raw === null ? null : Number(raw);

    // Distance brute (cm) mesuree par l'ESP32, transmise a titre de
    // diagnostic (optionnelle : absente si l'ESP32 n'envoie pas ce param).
    const rawDistanceParam = url.searchParams.get("raw_distance_cm");
    const rawDistanceCm =
      rawDistanceParam === null ? null : Number(rawDistanceParam);

    if (raw === null || Number.isNaN(tankLevel)) {
      log(`/water APPEL INVALIDE (tank_level manquant ou non numerique: "${raw}")`);
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "tank_level manquant ou invalide" }));
      return;
    }

    const distanceInfo =
      rawDistanceCm === null ? "" : ` (distance brute = ${rawDistanceCm} cm)`;

    if (tankLevel < 0) {
      log(`/water  -> CAPTEUR EN PANNE (tank_level=${tankLevel})${distanceInfo}`);
    } else {
      log(`/water  -> niveau cuve = ${tankLevel} %${distanceInfo}`);
    }

    // Reponse actuelle : simple accuse de reception.
    // Plus tard, tu pourras renvoyer une duree d'arrosage :
    //   const wateringSeconds = computeWateringSeconds(tankLevel);
    const body = {
      ok: true,
      received_tank_level: tankLevel,
      received_raw_distance_cm: rawDistanceCm,
      // watering_seconds: wateringSeconds,  // <- a activer plus tard
    };

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
    return;
  }

  // Toute autre route -> 404
  log(`Route inconnue : ${req.method} ${url.pathname}`);
  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "not found" }));
});

server.listen(PORT, () => {
  log(`Serveur de test demarre sur http://0.0.0.0:${PORT}`);
  log(`En attente des appels : GET /water?tank_level=XX`);
});
