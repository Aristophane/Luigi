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

## Documentation

- [Spécification du module de monitoring](docs/monitoring.md)
- [Contexte de design](.impeccable.md)
- [Installation de l’agent VPS](agent/README.md)

## État actuel

Le cockpit responsive, le socle PWA, PostgreSQL, l’initialisation mono-administrateur et la création persistante d’applications sont opérationnels. Les contrôles HTTP, observations, métriques de disponibilité sur 30 jours, incidents après trois échecs, récupérations et notifications internes sont branchés sur les données réelles.

L’intégration GitHub peut vérifier un jeton finement paramétré, le chiffrer avec `INTEGRATION_ENCRYPTION_KEY` et analyser les dépôts privés autorisés. Les dépôts publics sont analysables sans jeton. Le scanner inspecte les manifests racine, conserve le commit servant de preuve, détecte les technologies et vérifie jusqu’à 60 dépendances npm. Une contrainte n’acceptant plus la dernière version publiée génère automatiquement un constat et une tâche de maintenance.

Pour un jeton GitHub V1, accorde uniquement l’accès aux dépôts nécessaires avec la permission **Contents: Read-only**. Une GitHub App dédiée remplacera avantageusement ce mécanisme lors de la mise en production.

L’agent Ubuntu 24.04 et Debian peut maintenant être enrôlé depuis `/settings/vps`. Il remonte les métriques de capacité, mises à jour APT, redémarrage requis, état UFW, configuration SSH, services choisis et fraîcheur de sauvegarde. Les constats correspondants créent et résolvent automatiquement les tâches de maintenance sans doublons.

Les prochains incréments ajouteront la souscription Web Push persistante et le centre de notifications interactif, puis renforceront la gestion opérationnelle : rattachement des maintenances aux applications, historique et réouverture des tâches clôturées, suppression logique d'une application avec conservation de son historique, et affichage explicite de la fraîcheur des données VPS.
