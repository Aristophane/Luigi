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

Démarrer aussi **`npm run build:worker`, puis `npm run worker` dans un second terminal** : les contrôles, analyses, rapports et notifications utilisent une file persistante. Reconstruire le worker après une modification de son code ; `npm run worker:dev` permet de travailler directement sur les sources. Sans ce processus, `/api/ready` et `/api/health` répondent 503. Pour une installation existante, suivre le [déploiement Coolify pas à pas](docs/deployment-coolify.md) ou le [guide de fiabilité](docs/reliability.md) pour une installation directe et le témoin externe.

Cette version nécessite la migration **`0018_deployment_confirmation.sql`** avant le démarrage du nouveau web et du worker : appliquer les migrations avec `npm run db:migrate:prod` en production. Le déploiement actif utilise `compose.coolify.apps.yaml` ; le déploiement automatique depuis Git a été rétabli le 25 octobre 2026. Le diagnostic du 23 octobre concernant des images figées décrit une configuration antérieure.

Au premier démarrage, Luigi redirige vers `/setup` pour créer l’unique compte administrateur de la V1. Les créations de compte suivantes sont refusées côté serveur. Copie `.env.example` vers `.env.local` si ce fichier n’existe pas et remplace impérativement `BETTER_AUTH_SECRET` hors développement local.

## Commandes

- `npm run dev` : démarre l'application en développement ;
- `npm run worker` : démarre le planificateur autonome et les quatre files de traitement ;
- `npm run build:worker` : précompile le worker et ses modules en JavaScript ;
- `npm run worker:dev` : exécute les sources TypeScript pour le développement uniquement ;
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

Les contrôles de même fréquence sont répartis sur leur intervalle, tous espaces confondus : six contrôles à 60 secondes occupent six créneaux espacés de dix secondes. Le planificateur vérifie les échéances toutes les dix secondes. Les contrôles manuels restent immédiats et ne décalent pas les prochaines échéances automatiques. Après mise à jour, les contrôles déjà échus peuvent encore partir ensemble une fois ; leurs prochaines échéances sont ensuite réparties. Le worker de production exécute du JavaScript précompilé et charge seulement les modules nécessaires à chaque tâche.

Le bloc **Contrôle HTTP du contenu** ajoute des vérifications à la **page à contrôler**, par exemple une fiche produit `/produits/jade`, ou à défaut à la page d’accueil. Il sonde le HTML et la réponse d’une image ; JavaScript, l’affichage dans un navigateur et les parcours métier restent hors de ce contrôle. Le badge HTTP de chaque application décrit sa réponse HTTP ; l’état des contrôles essentiels, les dépendances et le déploiement restent distincts.

- **texte attendu** : chaîne littérale, sensible à la casse, recherchée dans le premier mégaoctet de la page (par exemple `srcset=`) ;
- **image** : Luigi charge l’image indiquée ou, par défaut, l’image la plus révélatrice de la page : d’abord une URL `/_next/image`, puis une image redimensionnée à la volée (paramètres `w`, `format`, `preset`… d’un serveur d’assets Vendure ou d’un CDN d’images), en privilégiant l’image principale aux vignettes chargées au défilement. Il vérifie un statut 2xx, un type `image/*` et un corps non vide. Le détail indique l’image testée et, le cas échéant, l’en-tête `x-nextjs-cache`.

Un échec compte dans le seuil d’ouverture d’un incident « rendu dégradé ». **Enregistrer et tester** invalide la preuve précédente et met un contrôle en file ; le worker l’exécute ensuite. Une réponse commencée avant la modification des réglages est écartée et un nouveau contrôle est réservé. Si le cache de l’optimiseur est chaud, une panne touchant seulement de nouvelles variantes d’image peut passer inaperçue ; les signaux du VPS apportent des indices complémentaires.

Le même appel planifie l’analyse des dépendances : toutes les 24 heures par défaut, avec jusqu’à trois nouvelles réservations par passage du planificateur. `DEPENDENCY_SCAN_INTERVAL_HOURS` règle la cadence (1 à 168 heures) et `DEPENDENCY_SCAN_BATCH_SIZE` la taille du lot (1 à 20). Un budget de **200 dépendances déclarées par dépôt, partagé entre npm et Python**, est interrogé sur les registres publics npm et PyPI. Les autres dépendances restent « à vérifier ».

Luigi recherche récursivement `package.json` et lui associe le `package-lock.json` le plus proche. Python couvre `requirements.txt` et ses variantes `requirements-*.txt`, `requirements_*.txt` et `requirements.*.txt`, avec un sous-ensemble de PEP 440 limité aux versions finales numériques. Marqueurs, URLs, index pip personnalisés et formes de version non prises en charge restent explicitement non suivis. Les dépendances de `pyproject.toml`, Composer, Go et Cargo ne sont pas suivies ; leurs technologies peuvent être détectées. Les lockfiles alternatifs, fichiers de plus de 1 Mo et plafonds de collecte sont signalés dans la couverture. Une contrainte acceptant la dernière version ne prouve pas la version installée ; les résultats décrivent le dépôt, pas la production.

Le cockpit indique l’état et la date du dernier scan, ses limites, puis sépare exécution, développement et outils/migrations selon le paquet et le chemin du manifeste. Des paquets npm d’une même famille peuvent former une seule mise à jour dans leur catégorie. Les constats et tâches restent contextualisés par manifeste ; une analyse complète après correction peut les résoudre. Cette analyse suit les versions disponibles et ne constitue pas une analyse de vulnérabilités.

## Version actuellement déployée

Le worker peut confirmer périodiquement la version active auprès de Coolify, Netlify et Railway. Voir [la configuration de la synchronisation des déploiements](docs/deployment-sync.md). Une confirmation du fournisseur reste valable deux heures ; la date de livraison peut être ancienne si la même version est toujours active.

Pour enregistrer aussi les événements CI, configure `DEPLOYMENT_INGEST_SECRET` puis appelle Luigi après une livraison réussie. Ce signal seul conserve un événement historique sans confirmer la version encore active. L’application est identifiée par son URL publique ou son UUID. `deploymentId` identifie une exécution de manière stable ; une répétition incompatible avec son SHA ou sa cible reçoit HTTP 409.

```http
POST /api/deployments
Authorization: Bearer <DEPLOYMENT_INGEST_SECRET>
Content-Type: application/json

{
  "applicationUrl": "https://shop.example.com",
  "deploymentId": "github-run-12345-1",
  "commitSha": "0123456789abcdef0123456789abcdef01234567",
  "source": "github-actions",
  "branch": "main",
  "environment": "production",
  "sourceUrl": "https://github.com/acme/shop/actions/runs/12345",
  "deployedAt": "2026-09-09T12:34:56Z"
}
```

Le cockpit affiche le commit, sa source, la date de livraison et la date de confirmation séparément. Il privilégie l’événement dernièrement confirmé, y compris lors d’un rollback. La comparaison dépôt/production exige une confirmation récente du fournisseur et une observation GitHub valide ; une simple réponse HTTP 200 ne suffit pas.

### Validité du jeton GitHub

Le worker vérifie le jeton enregistré toutes les heures, même sans dépôt surveillé. Les accès GitHub utilisés pour lister ou analyser les dépôts actualisent également son état. Le cockpit et **Paramètres → Intégrations** affichent la validité, la date du dernier contrôle et, en cas d’échec, le dernier accès réussi. **Vérifier le jeton** permet un contrôle immédiat sans ressaisir le secret.

Un refus HTTP 401 signale un jeton invalide, potentiellement expiré ou révoqué ; un refus de permissions, une limitation de requêtes, une panne réseau et une erreur de chiffrement restent distingués. Une notification interne dédupliquée indique où intervenir ; l’enregistrement d’un nouveau jeton valide la résout et relance immédiatement les analyses des applications actives, sans attendre le délai habituel de 24 heures après un scan en échec. Un contrôle qui confirme le retour de l’accès après une erreur relance également ces analyses. Les tâches déjà en attente reprennent immédiatement avec un nouveau budget de tentatives ; les analyses en cours conservent leur bail et aucun doublon actif n’est créé. Aucune date d’expiration n’est déduite d’un simple refus. Les anciennes intégrations sont indiquées « à vérifier » jusqu’à leur premier contrôle.

La comparaison des commits reste inconnue lorsque le jeton n’est pas confirmé, que l’observation du dépôt est antérieure au déploiement, qu’elle date de plus de 25 heures ou que la confirmation du fournisseur manque ou est périmée. Une différence de SHA ne présume pas lequel est en avance. Appliquer la migration 0018, puis reconstruire et redéployer **le web et le worker**.

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
- [Confirmation et synchronisation des déploiements](docs/deployment-sync.md)
- [Contexte de design](.impeccable.md)
- [Installation de l’agent VPS](agent/README.md)

## État actuel

Le cockpit responsive, le socle PWA, PostgreSQL, l’initialisation mono-administrateur et la création persistante d’applications sont opérationnels. Les contrôles HTTP, observations, métriques de disponibilité sur 30 jours, incidents après trois échecs, récupérations et notifications internes sont branchés sur les données réelles.

L’intégration GitHub vérifie et chiffre le jeton avec `INTEGRATION_ENCRYPTION_KEY` pour accéder aux dépôts privés autorisés ; les dépôts publics sont analysables sans jeton. Le scanner conserve le commit servant de preuve, détecte les technologies et suit jusqu’à 200 dépendances déclarées npm/Python selon les limites décrites ci-dessus. Une version ancienne détectée génère un constat et une tâche propres au manifeste concerné.

Pour un jeton GitHub V1, accorde uniquement l’accès aux dépôts nécessaires avec la permission **Contents: Read-only**. Une GitHub App dédiée remplacera avantageusement ce mécanisme lors de la mise en production.

L’agent Ubuntu 24.04 et Debian peut maintenant être enrôlé depuis `/settings/vps`. Il remonte les métriques de capacité, mises à jour APT, redémarrage requis, état UFW, configuration SSH, services choisis et fraîcheur de sauvegarde. Les constats correspondants créent et résolvent automatiquement les tâches de maintenance sans doublons.

Les signaux d’exécution complètent la mémoire globale du VPS, qui ne voit pas un processus Node saturé dans un conteneur. Pour chaque conteneur ou service suivi, Luigi crée un constat critique après un arrêt par manque de mémoire, un constat élevé ou critique après des redémarrages automatiques, et un constat élevé quand la mémoire reste au-dessus de 85 % de la limite du conteneur sur deux collectes. Les arrêts restent signalés 24 heures. Si le noyau arrête un processus que le collecteur n’a pas pu rattacher, ou si le collecteur ne répond plus, le compteur du noyau déclenche un constat au niveau du VPS. Le constat de limite mémoire ne s’applique qu’aux conteneurs dotés d’une limite dans Coolify.

La gestion opérationnelle relie maintenant les maintenances aux applications, conserve leur historique, permet leur réouverture et archive une application sans effacer ses traces. Le cockpit affiche également la fraîcheur et la cadence des rapports VPS.

L’explorateur `/storage` ajoute un inventaire disque détaillé toutes les six heures : carte proportionnelle inspirée de WinDirStat, table accessible, évolution entre deux scans, attribution automatique ou manuelle aux applications et création de tâches de maintenance. Les instantanés sont conservés 90 jours et aucune suppression de fichier n’est exposée dans Luigi.

Le centre `/maintenance` classe les actions par application, criticité, catégorie et état. Chaque opération expose son contexte, une procédure, les contrôles à effectuer avant clôture et son journal d’audit. Les actions de sécurité disposent d’un accès direct et les notifications correspondantes ouvrent désormais ce niveau de détail.

Le Web Push persistant et le centre de notifications interactif sont branchés. Les alertes critiques ou élevées, les sources silencieuses et les récupérations sont dédupliquées puis distribuées aux navigateurs abonnés. Les scans planifiés de dépendances sont actifs ; le prochain incrément prioritaire porte sur l’agrégation des vulnérabilités OSV ou Dependabot.
