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

- `GET /api/status` : derniere mesure (pourcentage, litres, drapeau "trop proche"), reglages, vacances et dernier releve meteo.
- `GET /api/waterings` / `GET /api/measurements` : historiques.
- `PUT /api/settings` : `{ daily_watering_seconds, flow_l_per_min,
  frost_alert_enabled }`.
- `PUT /api/vacation` : `{ active, days, available_liters, margin_percent }`.
- `PUT /api/watering-enabled` : `{ enabled: true }`, réactive explicitement
  l'arrosage après un arrêt de sécurité Telegram.

## Cuve basse et arrêt de sécurité

À chaque mesure valide, un niveau inférieur ou égal à **5 %** déclenche une
alerte Telegram. Les boutons associés à cette livraison précise sont :

- **Oui** : désactive les arrosages automatiques et exceptionnels, annule une
  demande manuelle en attente et invalide son `request_id`. Seul le bouton
  « Réactiver l'arrosage » de l'application React peut reprendre l'arrosage.
- **Non** : maintient l'arrosage et réarme immédiatement l'alerte : chaque
  nouvelle mesure valide à 5 % ou moins envoie une nouvelle alerte.
- **Désactiver l'alerte** : maintient l'arrosage mais coupe uniquement les
  alertes de cuve basse jusqu'à une mesure valide strictement supérieure à 5 %.
  Ce réarmement ne réactive jamais l'arrosage.

Chaque bouton contient un identifiant de livraison unique. Une ancienne alerte
ne peut donc plus modifier l'état après un remplissage ou l'envoi d'une alerte
plus récente.

## Alertes meteo

Cloud Scheduler appelle le serveur chaque soir a **20 h** (heure de Paris), qui
consulte alors une seule fois la prevision Open-Meteo pour Saint-Ouen-sur-Seine.
En cas d'echec Open-Meteo, de la base ou de Telegram, le serveur effectue au
maximum trois tentatives espacees de cinq minutes. Aucun compte ni cle API
n'est necessaire pour Open-Meteo.

Le dernier releve reussi est conserve et affiche dans l'application : cumul de
precipitations de la journee et temperature minimale la plus basse sur les
sept jours de prevision.

- **Gel** : une temperature minimale strictement inferieure a **5 °C** dans les
  7 prochains jours envoie une alerte Telegram. Elle est renvoyee chaque soir
  tant que le risque persiste. Le bouton **Me le rappeler demain** suspend
  seulement l'alerte du soir courant ; **Masquer jusqu'au retour au chaud**
  coupe les alertes jusqu'a ce que l'ensemble de la prevision repasse a 5 °C
  ou plus. Le bouton correspondant de l'application peut desactiver ou
  reactiver entierement ces alertes.
- **Pluie** : a partir de **6 mm** de precipitation prevue/cumulee sur la
  journee, une alerte demande si l'arrosage automatique du lendemain doit etre
  maintenu. Sans reponse, il est conserve. Le choix **Non** annule uniquement
  le cycle automatique de la date suivante, sans modifier les arrosages
  exceptionnels ni les reglages habituels.

## Mode vacances

Quantite disponible (moins la marge, 5 % par defaut) repartie equitablement sur
N jours. A la fin de la periode, l'arrosage s'arrete jusqu'a desactivation
manuelle dans l'app.

## Estimation de l'eau versee

- **Debit** : duree x debit (reglage `flow_l_per_min`, 1,26 L/min par defaut).
- **Capteur** : difference de volume (cone tronque de la cuve) entre la mesure
  d'avant-arrosage et celle du lendemain. Non calculee si une des mesures est a
  moins de 20,7 cm du capteur (zone non fiable du JSN-SR04T).

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

Les alertes meteo necessitent aussi `WEATHER_SCHEDULER_SECRET`, une valeur
aleatoire longue partagee uniquement avec la tache Cloud Scheduler. La tache
doit envoyer une requete `POST` quotidienne a
`/internal/weather-check`, avec cet en-tete :
`X-Weather-Scheduler-Secret: <valeur du secret>`. Elle doit etre planifiee avec
`0 20 * * *`, le fuseau `Europe/Paris`, et une echeance d'au moins 15 minutes
pour laisser les tentatives se terminer.

## Installation sur Android (PWA)

Ouvrir l'URL du serveur dans Chrome -> menu (3 points) -> "Ajouter a l'ecran
d'accueil" / "Installer l'application".
