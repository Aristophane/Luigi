# Luigi

Luigi est un cockpit de supervision et de maintenance pour agréger la disponibilité des applications, l'état d'un VPS Ubuntu, les événements GitHub et les dépendances à mettre à jour.

## Démarrage local

Prérequis : Node.js 24 LTS et Docker Desktop.

```bash
npm install
docker compose up -d postgres
npm run db:migrate
npm run dev
```

Ouvrir ensuite [http://localhost:3011](http://localhost:3011).

Démarrer aussi **`npm run worker` dans un second terminal** : les contrôles, analyses, rapports et notifications utilisent désormais une file persistante. Sans ce processus, `/api/ready` et `/api/health` répondent 503. Pour une installation existante, suivre le [déploiement Coolify pas à pas](docs/deployment-coolify.md) ou le [guide de fiabilité](docs/reliability.md) pour une installation directe et le témoin externe.

Au premier démarrage, Luigi redirige vers `/setup` pour créer l’unique compte administrateur de la V1. Les créations de compte suivantes sont refusées côté serveur. Copie `.env.example` vers `.env.local` si ce fichier n’existe pas et remplace impérativement `BETTER_AUTH_SECRET` hors développement local.

## Commandes

- `npm run dev` : démarre l'application en développement ;
- `npm run worker` : démarre le planificateur autonome et les quatre files de traitement ;
- `npm test` : vérifie les règles et, avec `TEST_DATABASE_URL`, les transactions et reprises PostgreSQL ;
- `npm run build` : produit la version de production ;
- `npm run lint` : vérifie la qualité du code ;
- `npm run typecheck` : vérifie les types TypeScript.
- `npm run db:generate` : génère une migration après modification du schéma ;
- `npm run db:migrate` : applique les migrations à PostgreSQL ;
- `npm run db:studio` : ouvre l’explorateur de données Drizzle.

## Contrôles de disponibilité

Chaque application reçoit un contrôle HTTP lors de sa création. Le bouton d’actualisation du cockpit réserve les contrôles de l’espace courant ; le worker les exécute. Les résultats conservent le statut HTTP, la latence, le détail normalisé et la date de collecte. La couverture et les interruptions sont affichées séparément de la disponibilité mesurée ; un contrôle essentiel périmé rend l’état inconnu.

Pour une exécution planifiée externe, configure `MONITOR_CRON_SECRET`, puis appelle régulièrement :

```http
POST /api/cron/monitor
Authorization: Bearer <MONITOR_CRON_SECRET>
```

Cet endpoint facultatif réserve les tâches arrivées à échéance et renvoie 202. Le worker planifie aussi les contrôles de façon autonome. Une application passe en vigilance au premier échec ; un incident critique et une notification interne sont créés après trois échecs consécutifs. Le premier succès suivant résout automatiquement cet incident. Les redirections sont contrôlées et les adresses locales ou privées sont refusées afin de limiter les risques SSRF.

Le bloc **Contrôle du rendu** de chaque application ajoute des vérifications au contrôle HTTP, car une page peut répondre HTTP 200 alors que ses images ne se chargent plus. Elles s’appliquent à la **page à contrôler**, par exemple une fiche produit `/produits/jade`, ou à défaut à la page d’accueil ; la disponibilité reste mesurée sur la page d’accueil :

- **texte attendu** : chaîne littérale, sensible à la casse, recherchée dans le premier mégaoctet de la page (par exemple `srcset=`) ;
- **image** : Luigi charge l’image indiquée ou, par défaut, l’image la plus révélatrice de la page : d’abord une URL `/_next/image`, puis une image redimensionnée à la volée (paramètres `w`, `format`, `preset`… d’un serveur d’assets Vendure ou d’un CDN d’images), en privilégiant l’image principale aux vignettes chargées au défilement. Il vérifie un statut 2xx, un type `image/*` et un corps non vide. Le détail indique l’image testée et, le cas échéant, l’en-tête `x-nextjs-cache`.

Un échec compte comme un échec du contrôle : au même seuil, Luigi ouvre un incident « rendu dégradé », distinct d’une indisponibilité. « Enregistrer et tester » exécute immédiatement le contrôle. Si le cache de l’optimiseur est chaud, une panne qui ne touche que les nouvelles variantes d’image peut passer inaperçue : les signaux d’exécution du VPS couvrent ce cas.

Le même appel planifie aussi l’analyse des dépendances. Par défaut, chaque dépôt est revérifié toutes les 24 heures, par lots de trois applications afin de ménager GitHub et le registre npm. `DEPENDENCY_SCAN_INTERVAL_HOURS` règle la cadence (de 1 à 168 heures) et `DEPENDENCY_SCAN_BATCH_SIZE` la taille du lot (de 1 à 20). Luigi recherche récursivement les `package.json`, jusqu’à 200 dépendances npm, et associe chaque solution au `package-lock.json` le plus proche. Deux solutions d’un même dépôt peuvent ainsi utiliser et suivre des versions différentes d’une bibliothèque. Une nouvelle version crée une notification et une tâche de maintenance contextualisées par le chemin du manifeste ; une analyse après mise à jour les résout automatiquement. Les paquets d’un même scope publiés dans la même version, comme `@vendure/*`, forment une seule mise à jour. Le cockpit classe les bibliothèques par importance (frameworks, dépendances d’exécution, versions majeures) et signale sur l’étiquette de la technologie la version disponible de son paquet principal.

## Version actuellement déployée

Configure `DEPLOYMENT_INGEST_SECRET`, puis ajoute un appel à Luigi à la fin d’un déploiement réussi. L’application peut être identifiée par son URL publique ou son UUID. `deploymentId` doit identifier une exécution de manière stable afin qu’une relance du même signal ne crée pas de doublon.

```http
POST /api/deployments
Authorization: Bearer <DEPLOYMENT_INGEST_SECRET>
Content-Type: application/json

{
  "applicationUrl": "https://shop.example.com",
  "deploymentId": "github-run-12345-1",
  "commitSha": "0123456789abcdef0123456789abcdef01234567",
  "source": "github-actions",
  "sourceUrl": "https://github.com/acme/shop/actions/runs/12345",
  "deployedAt": "2026-09-09T12:34:56Z"
}
```

Le cockpit affiche le commit court, son message pour la tête du dépôt, la date, la source et un accès au déploiement. Les dépôts déjà enregistrés récupèrent le message lors de leur prochaine analyse. Il indique aussi lorsque la branche analysée sur GitHub contient un commit plus récent que celui actuellement en production.

## Notifications Web Push

Génère une paire VAPID unique, puis conserve les deux valeurs dans les variables d’environnement de Luigi :

```bash
npx web-push generate-vapid-keys --json
```

- `NEXT_PUBLIC_VAPID_PUBLIC_KEY` : clé publique transmise aux navigateurs ;
- `VAPID_PRIVATE_KEY` : clé privée, exclusivement côté serveur ;
- `VAPID_SUBJECT` : contact du service, par exemple `mailto:admin@example.com`.

Chaque navigateur est enregistré séparément et peut être testé ou révoqué depuis le cockpit. Les souscriptions expirées sont nettoyées automatiquement. Les incidents critiques, alertes élevées, silences de collecte et retours à la normale peuvent alors être reçus lorsque Luigi n’est pas ouvert.

Le worker évalue les silences de chaque serveur toutes les dix secondes, même en l’absence de cron ou de rapports entrants. Un témoin sur une autre machine doit vérifier `/api/ready` pour détecter également l’arrêt complet de Luigi.

## Notifications Discord

Discord sert de second canal, indépendant des navigateurs abonnés. Dans le salon choisi, ouvre **Paramètres du salon → Intégrations → Webhooks**, crée un webhook et copie son URL dans `DISCORD_WEBHOOK_URL`, puis redémarre Luigi. Seules les URL HTTPS de `discord.com` sous `/api/webhooks/` sont acceptées.

Luigi y publie les mêmes événements que le Web Push : incidents critiques, alertes élevées, silences de collecte et retours à la normale, avec un lien vers le cockpit construit à partir de `BETTER_AUTH_URL`. Les mentions `@everyone` et `@here` sont neutralisées. Un envoi est limité à cinq secondes et un échec est journalisé sans bloquer l’incident. **Paramètres → Intégrations** indique si le canal est prêt et permet d’envoyer un message de test. Pour être alerté sur mobile, règle les notifications du salon sur « Tous les messages ».

## Documentation

- [Spécification du module de monitoring](docs/monitoring.md)
- [Worker, reprises, couverture et témoin externe](docs/reliability.md)
- [Contexte de design](.impeccable.md)
- [Installation de l’agent VPS](agent/README.md)

## État actuel

Le cockpit responsive, le socle PWA, PostgreSQL, l’initialisation mono-administrateur et la création persistante d’applications sont opérationnels. Les contrôles HTTP, observations, métriques de disponibilité sur 30 jours, incidents après trois échecs, récupérations et notifications internes sont branchés sur les données réelles.

L’intégration GitHub peut vérifier un jeton finement paramétré, le chiffrer avec `INTEGRATION_ENCRYPTION_KEY` et analyser les dépôts privés autorisés. Les dépôts publics sont analysables sans jeton. Le scanner inspecte récursivement les manifests, conserve le commit servant de preuve, détecte les technologies — dont Vendure via `@vendure/core` — et vérifie jusqu’à 200 dépendances npm. Une version verrouillée plus ancienne, ou à défaut une contrainte n’acceptant plus la dernière version publiée, génère automatiquement un constat et une tâche de maintenance propres à la solution concernée.

Pour un jeton GitHub V1, accorde uniquement l’accès aux dépôts nécessaires avec la permission **Contents: Read-only**. Une GitHub App dédiée remplacera avantageusement ce mécanisme lors de la mise en production.

L’agent Ubuntu 24.04 et Debian peut maintenant être enrôlé depuis `/settings/vps`. Il remonte les métriques de capacité, mises à jour APT, redémarrage requis, état UFW, configuration SSH, services choisis et fraîcheur de sauvegarde. Les constats correspondants créent et résolvent automatiquement les tâches de maintenance sans doublons.

Les signaux d’exécution complètent la mémoire globale du VPS, qui ne voit pas un processus Node saturé dans un conteneur. Pour chaque conteneur ou service suivi, Luigi crée un constat critique après un arrêt par manque de mémoire, un constat élevé ou critique après des redémarrages automatiques, et un constat élevé quand la mémoire reste au-dessus de 85 % de la limite du conteneur sur deux collectes. Les arrêts restent signalés 24 heures. Si le noyau arrête un processus que le collecteur n’a pas pu rattacher, ou si le collecteur ne répond plus, le compteur du noyau déclenche un constat au niveau du VPS. Le constat de limite mémoire ne s’applique qu’aux conteneurs dotés d’une limite dans Coolify.

La gestion opérationnelle relie maintenant les maintenances aux applications, conserve leur historique, permet leur réouverture et archive une application sans effacer ses traces. Le cockpit affiche également la fraîcheur et la cadence des rapports VPS.

L’explorateur `/storage` ajoute un inventaire disque détaillé toutes les six heures : carte proportionnelle inspirée de WinDirStat, table accessible, évolution entre deux scans, attribution automatique ou manuelle aux applications et création de tâches de maintenance. Les instantanés sont conservés 90 jours et aucune suppression de fichier n’est exposée dans Luigi.

Le centre `/maintenance` classe les actions par application, criticité, catégorie et état. Chaque opération expose son contexte, une procédure, les contrôles à effectuer avant clôture et son journal d’audit. Les actions de sécurité disposent d’un accès direct et les notifications correspondantes ouvrent désormais ce niveau de détail.

Le Web Push persistant et le centre de notifications interactif sont branchés. Les alertes critiques ou élevées, les sources silencieuses et les récupérations sont dédupliquées puis distribuées aux navigateurs abonnés. Les scans planifiés de dépendances sont actifs ; le prochain incrément prioritaire porte sur l’agrégation des vulnérabilités OSV ou Dependabot.
