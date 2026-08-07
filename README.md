# Serveur d'arrosage automatique

Serveur Node/Express du systeme d'arrosage ESP32 :
- endpoints appeles par l'ESP32 (`/init`, `/water`)
- persistence PostgreSQL (Neon) : mesures, arrosages, reglages, mode vacances
- application mobile (React PWA installable) servie sur `/`

## Endpoints ESP32

- `GET /init?tank_level=...` : diagnostic de demarrage, enregistre la mesure, repond 204.
- `GET /water?tank_level=...` : enregistre la mesure et l'arrosage, renvoie
  `{ watering_seconds }` selon les reglages ou le mode vacances.
  Si la base est injoignable, renvoie la duree de secours (500 s).

## API de l'application

- `GET /api/status` : derniere mesure (pourcentage, litres, drapeau "trop proche"), reglages, vacances.
- `GET /api/waterings` / `GET /api/measurements` : historiques.
- `PUT /api/settings` : `{ daily_watering_seconds, flow_l_per_min }`.
- `PUT /api/vacation` : `{ active, days, available_liters, margin_percent }`.

## Mode vacances

Quantite disponible (moins la marge, 5 % par defaut) repartie equitablement sur
N jours. A la fin de la periode, l'arrosage s'arrete jusqu'a desactivation
manuelle dans l'app.

## Estimation de l'eau versee

- **Debit** : duree x debit (reglage `flow_l_per_min`, 1,26 L/min par defaut).
- **Capteur** : difference de volume (cone tronque de la cuve) entre la mesure
  d'avant-arrosage et celle du lendemain. Non calculee si une des mesures est a
  moins de 25 cm du capteur (zone non fiable du JSN-SR04T).

## Developpement

```bash
npm install
DATABASE_URL="postgresql://..." node index.js   # serveur sur :3000
cd app && npm install && npm run dev            # app React sur :5173 (proxy /api)
```

Build de l'app : `npm run build:app` (sortie dans `public/`, servie par Express).

## Deploiement Heroku

- `heroku-postbuild` builde l'app automatiquement a chaque deploiement.
- Config requise : variable d'environnement `DATABASE_URL` (connection string Neon).

## Installation sur Android (PWA)

Ouvrir l'URL du serveur dans Chrome -> menu (3 points) -> "Ajouter a l'ecran
d'accueil" / "Installer l'application".
