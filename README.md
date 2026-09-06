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
- `GET /command` et `GET /manual-water` : protocole d'arrosage exceptionnel.
  Une commande annulee, remplacee ou bloquee est refusee avant l'activation de
  la pompe grâce à son `request_id`.

## API de l'application

- `GET /api/status` : derniere mesure (pourcentage, litres, drapeau "trop proche"), reglages, vacances.
- `GET /api/waterings` / `GET /api/measurements` : historiques.
- `PUT /api/settings` : `{ daily_watering_seconds, flow_l_per_min }`.
- `PUT /api/vacation` : `{ active, days, available_liters, margin_percent }`.
- `PUT /api/watering-enabled` : `{ enabled: true }`, réactive explicitement
  l'arrosage après un arrêt de sécurité Telegram.

## Cuve basse et arrêt de sécurité

À chaque mesure valide, un niveau inférieur ou égal à **5 %** déclenche une
alerte Telegram une seule fois. L'alerte est de nouveau armée après une mesure
strictement supérieure à 5 %. Ce réarmement ne réactive jamais l'arrosage.

Le bouton Telegram **Oui** désactive les arrosages automatiques et
exceptionnels, annule une demande manuelle en attente et invalide son
`request_id`. Seul le bouton « Réactiver l'arrosage » de l'application React
peut ensuite reprendre l'arrosage.

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

## Déploiement Cloud Run

Cloud Build déploie le service `watering-esp32-server` dans `europe-west1`.
Configurer `DATABASE_URL`, `TELEGRAM_BOT_TOKEN` et `TELEGRAM_CHAT_ID` comme
variables d'environnement du service (ou références Secret Manager) pour la
persistance et les notifications classiques.

Les boutons d'action de cuve basse nécessitent **deux variables
supplémentaires obligatoires** :

- `TELEGRAM_WEBHOOK_URL` : URL HTTPS publique complète du service Cloud Run,
  terminée par `/telegram/webhook`.
- `TELEGRAM_WEBHOOK_SECRET` : secret aléatoire dédié au webhook Telegram,
  conservé comme secret de configuration (jamais dans le dépôt).

Au démarrage, le serveur enregistre automatiquement ce webhook auprès de
Telegram avec ce secret et limite les mises à jour reçues à `callback_query`.
Après avoir défini ou modifié ces variables, déployer une nouvelle révision
Cloud Run. Si l'une des deux est absente, le serveur le signale explicitement
dans ses logs : les messages Telegram existants continuent de fonctionner,
mais l'alerte de cuve basse est envoyée sans boutons d'action.

## Installation sur Android (PWA)

Ouvrir l'URL du serveur dans Chrome -> menu (3 points) -> "Ajouter a l'ecran
d'accueil" / "Installer l'application".
