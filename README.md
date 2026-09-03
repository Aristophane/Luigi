# Luigi

Luigi est un cockpit de supervision et de maintenance pour agréger la disponibilité des applications, l'état d'un VPS Ubuntu, les événements GitHub et les dépendances à mettre à jour.

## Démarrage local

Prérequis : Node.js 20.9 ou plus récent et Docker Desktop.

```bash
npm install
docker compose up -d postgres
npm run db:migrate
npm run dev
```

Ouvrir ensuite [http://localhost:3011](http://localhost:3011).

Au premier démarrage, Luigi redirige vers `/setup` pour créer l’unique compte administrateur de la V1. Les créations de compte suivantes sont refusées côté serveur. Copie `.env.example` vers `.env.local` si ce fichier n’existe pas et remplace impérativement `BETTER_AUTH_SECRET` hors développement local.

## Commandes

- `npm run dev` : démarre l'application en développement ;
- `npm run build` : produit la version de production ;
- `npm run lint` : vérifie la qualité du code ;
- `npm run typecheck` : vérifie les types TypeScript.
- `npm run db:generate` : génère une migration après modification du schéma ;
- `npm run db:migrate` : applique les migrations à PostgreSQL ;
- `npm run db:studio` : ouvre l’explorateur de données Drizzle.

## Contrôles de disponibilité

Chaque application reçoit un contrôle HTTP lors de sa création. Le bouton d’actualisation du cockpit exécute immédiatement les contrôles de l’espace courant. Les résultats conservent le statut HTTP, la latence, le détail normalisé et la date de collecte.

Pour une exécution planifiée externe, configure `MONITOR_CRON_SECRET`, puis appelle régulièrement :

```http
POST /api/cron/monitor
Authorization: Bearer <MONITOR_CRON_SECRET>
```

L’endpoint n’exécute que les contrôles arrivés à échéance. Une application passe en vigilance au premier échec ; un incident critique et une notification interne sont créés après trois échecs consécutifs. Le premier succès suivant résout automatiquement l’incident. Les redirections sont contrôlées et les adresses locales ou privées sont refusées afin de limiter les risques SSRF.

## Notifications Web Push

Génère une paire VAPID unique, puis conserve les deux valeurs dans les variables d’environnement de Luigi :

```bash
npx web-push generate-vapid-keys --json
```

- `NEXT_PUBLIC_VAPID_PUBLIC_KEY` : clé publique transmise aux navigateurs ;
- `VAPID_PRIVATE_KEY` : clé privée, exclusivement côté serveur ;
- `VAPID_SUBJECT` : contact du service, par exemple `mailto:admin@example.com`.

Chaque navigateur est enregistré séparément et peut être testé ou révoqué depuis le cockpit. Les souscriptions expirées sont nettoyées automatiquement. Les incidents critiques, alertes élevées, silences de collecte et retours à la normale peuvent alors être reçus lorsque Luigi n’est pas ouvert.

`MONITOR_CRON_INTERVAL_SECONDS` doit correspondre à la fréquence réelle d’appel du cron. Luigi compare ce rythme à celui de l’agent VPS pour détecter qu’une source est devenue silencieuse sans générer de doublons.

## Documentation

- [Spécification du module de monitoring](docs/monitoring.md)
- [Contexte de design](.impeccable.md)
- [Installation de l’agent VPS](agent/README.md)

## État actuel

Le cockpit responsive, le socle PWA, PostgreSQL, l’initialisation mono-administrateur et la création persistante d’applications sont opérationnels. Les contrôles HTTP, observations, métriques de disponibilité sur 30 jours, incidents après trois échecs, récupérations et notifications internes sont branchés sur les données réelles.

L’intégration GitHub peut vérifier un jeton finement paramétré, le chiffrer avec `INTEGRATION_ENCRYPTION_KEY` et analyser les dépôts privés autorisés. Les dépôts publics sont analysables sans jeton. Le scanner inspecte les manifests racine, conserve le commit servant de preuve, détecte les technologies et vérifie jusqu’à 60 dépendances npm. Une contrainte n’acceptant plus la dernière version publiée génère automatiquement un constat et une tâche de maintenance.

Pour un jeton GitHub V1, accorde uniquement l’accès aux dépôts nécessaires avec la permission **Contents: Read-only**. Une GitHub App dédiée remplacera avantageusement ce mécanisme lors de la mise en production.

L’agent Ubuntu 24.04 et Debian peut maintenant être enrôlé depuis `/settings/vps`. Il remonte les métriques de capacité, mises à jour APT, redémarrage requis, état UFW, configuration SSH, services choisis et fraîcheur de sauvegarde. Les constats correspondants créent et résolvent automatiquement les tâches de maintenance sans doublons.

La gestion opérationnelle relie maintenant les maintenances aux applications, conserve leur historique, permet leur réouverture et archive une application sans effacer ses traces. Le cockpit affiche également la fraîcheur et la cadence des rapports VPS.

L’explorateur `/storage` ajoute un inventaire disque détaillé toutes les six heures : carte proportionnelle inspirée de WinDirStat, table accessible, évolution entre deux scans, attribution automatique ou manuelle aux applications et création de tâches de maintenance. Les instantanés sont conservés 90 jours et aucune suppression de fichier n’est exposée dans Luigi.

Le centre `/maintenance` classe les actions par application, criticité, catégorie et état. Chaque opération expose son contexte, une procédure, les contrôles à effectuer avant clôture et son journal d’audit. Les actions de sécurité disposent d’un accès direct et les notifications correspondantes ouvrent désormais ce niveau de détail.

Le Web Push persistant et le centre de notifications interactif sont branchés. Les alertes critiques ou élevées, les sources silencieuses et les récupérations sont dédupliquées puis distribuées aux navigateurs abonnés. Le prochain incrément prioritaire porte sur les scans planifiés de dépendances et l’agrégation des vulnérabilités OSV ou Dependabot.
