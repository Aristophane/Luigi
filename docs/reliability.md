# Exécution fiable de la supervision

**Avec Coolify et les ressources `luigi:main` / `luigi-database`, suivre d'abord le [guide de déploiement Coolify pas à pas](deployment-coolify.md).** Il utilise un worker Dockerfile qui applique lui-même les migrations avant de démarrer ; les instructions systemd ci-dessous concernent une installation directe hors Coolify.

## Mise en service

Le serveur web reçoit les événements et réserve des tâches PostgreSQL. Un **processus séparé est désormais obligatoire** : `npm run worker`. Il faut Node.js 22.15+ (24 LTS recommandé), le code source et TypeScript installé, y compris en production. Le worker utilise les mêmes variables `DATABASE_URL`, `INTEGRATION_ENCRYPTION_KEY`, Discord et VAPID que le web. Il ne dépend ni de requêtes HTTP ni d’un cron externe.

Pour mettre à jour une installation existante :

1. Arrêter temporairement les anciens processus web/cron avant la migration.
2. Exécuter `npm ci` puis `npm run db:migrate:prod` avec `DATABASE_URL` défini. La migration `0017` conserve les jetons et les identités des agents existants, rattache leur historique au serveur et initialise les états par contrôle.
3. Construire et démarrer le web (`npm run build`, `npm start`).
4. Démarrer le worker avec `npm run worker`, sous un superviseur qui le relance. Un exemple systemd est fourni dans `deploy/luigi-worker.service` ; adapter le compte `luigi`, les chemins et `/etc/luigi/worker.env`.
5. Vérifier que `/api/ready` répond 200. Sans worker, il répond 503. `/api/health` effectue les mêmes vérifications : PostgreSQL, fraîcheur du planificateur et des quatre files, absence de retard excessif.
6. Mettre à jour les fichiers Python de l’agent pour transmettre les métadonnées d’exhaustivité. Pour conserver son identité, remplacer les scripts dans `/opt/luigi-agent/` sans réenrôler le serveur. Les anciens agents restent compatibles, mais leurs observations runtime sont considérées partielles.

Le cron `POST /api/cron/monitor` devient facultatif : il réserve les tâches dues et renvoie **202**, sans attendre de résultats. Les boutons d’actualisation, d’analyse et de contrôle du rendu utilisent également la file ; le cockpit recharge ses données toutes les 15 secondes lorsqu’il est visible.

## Réservations et budgets

| File | Exécutions simultanées, tous workers confondus | Budget par tentative |
| --- | ---: | ---: |
| Contrôles | 4 | 90 s |
| Analyses de dépendances | 1 | 600 s |
| Rapports agents | 2 | 90 s |
| Notifications | 4 | 20 s |

Les tâches actives portent une clé unique et un bail expirant 15 secondes après leur budget. La réservation est atomique (`FOR UPDATE SKIP LOCKED` et verrou transactionnel par file). Les rapports d’un même agent sont sérialisés. Chaque traitement s’exécute dans un processus enfant arrêté à l’expiration du budget ; un jeton de réservation interdit à une ancienne tentative d’enregistrer ses résultats après une reprise.

Cinq tentatives au maximum, avec délais de 15, 30, 60 puis 120 secondes. Un arrêt brutal laisse un bail récupérable. Une tâche épuisée reste dans le journal en échec ; elle n’est pas oubliée. Les contrôles et analyses ont ensuite de nouvelles échéances. Les échecs définitifs de rapports sont visibles dans le suivi ; leur reprise exige une intervention. Le journal de tâches n’a pas de purge automatique dans cette version.

L’acceptation d’un rapport, sa tâche et son heartbeat sont une transaction unique. Le traitement des règles, des tâches de maintenance, des notifications et le marqueur `processed_at` forment une seconde transaction. Une panne ne peut donc pas persister une résolution sans son signal de récupération. Un rapport doublon reçoit un acquittement sans créer une autre tâche. Les rapports anciens ou arrivés hors ordre sont conservés avec l’état `stale` et ne modifient pas les constats.

## Livraison des notifications

Une notification et ses envois Discord / Web Push sont créés dans la même transaction. Chaque navigateur a sa propre livraison : un destinataire déjà livré n’est pas réexpédié lors de la reprise d’un autre. Les appels sont limités à cinq secondes. Un refus temporaire, une limite de débit ou une panne réseau entraîne une nouvelle tentative ; une erreur permanente ou un abonnement expiré possède un résultat explicite.

**Paramètres → Intégrations → Supervision et livraison** affiche les états et chaque tentative, y compris un démarrage sans résultat confirmé après un arrêt. Une relance manuelle est disponible pour les envois terminés en échec ou sans canal configuré.

La livraison est *au moins une fois* : si Discord ou le navigateur accepte l’envoi puis que le processus s’arrête avant l’enregistrement du résultat, une reprise peut produire un doublon. Le tag Web Push reste stable. Aucun fournisseur utilisé ici ne fournit une transaction commune avec PostgreSQL.

Les notifications historiques antérieures à cette migration n’ont pas de journal de livraison rétroactif. Aucun envoi historique n’est déclenché implicitement par la migration. Une notification de nouveau actualisée par les règles peut créer ses envois manquants ; les envois déjà enregistrés dans la nouvelle file conservent leurs résultats.

## États, couverture et services essentiels

Chaque contrôle possède son état, sa dernière mesure et sa prochaine échéance. L’état affiché d’une application combine les contrôles essentiels : critique si une panne récente est connue, inconnu si une preuve essentielle manque ou est périmée, puis vigilance ou sain. Un contrôle devient périmé après deux intervalles plus 60 secondes.

La disponibilité affichée est pondérée par le temps couvert des contrôles essentiels. Chaque mesure couvre au plus un intervalle, interrompu par la mesure suivante ; une mesure inconnue ne couvre aucune durée. Les contrôles manuels rapprochés n’augmentent pas artificiellement la couverture. Les statistiques portent sur la période depuis l’activation du contrôle, plafonnée à 30 jours. Le pourcentage de couverture, les interruptions et le temps sans mesure sont affichés séparément. Pour plusieurs contrôles essentiels, ces durées sont additionnées : ce sont des durées de contrôle, pas un SLA de bout en bout.

**Paramètres → VPS** liste chaque serveur et permet d’associer un conteneur/service observé à l’application dont il est essentiel. Le statut sera confirmé au rapport suivant. Les identifiants de serveurs isolent les règles, les historiques et les heartbeats. Un nouvel enrôlement crée un nouveau serveur ; il ne révoque pas les agents précédents.

Le collecteur conserve les budgets de 40 unités et 50 événements par rapport. Il fait tourner les lots d’unités et publie `complete`/`partial`, les nombres omis, les erreurs de collecte et le début de la couverture des événements. `LUIGI_RUNTIME_UNITS` permet une sélection explicite de clés séparées par des virgules, par exemple `container:shop/api,service:nginx.service`. Les événements restent conservés localement dans un historique borné ; une perte y est signalée pendant la fenêtre concernée.

Une unité absente, arrêtée, sans mesure mémoire, ou une collecte obsolète ne prouve pas une récupération. La pression mémoire se résout sur une unité présente et active, mesurée sous 80 %. Un crash se résout sur une unité présente et active avec une fenêtre d’événements complète de 24 h sans nouveau crash. Les états de sécurité inconnus et les sauvegardes absentes ne résolvent plus les alertes correspondantes.

## Témoin externe indépendant

Installer **sur une autre machine**, idéalement chez un autre hébergeur, `scripts/watchdog.mjs` dans `/opt/luigi-witness/` et les unités `deploy/luigi-witness.service` et `.timer`. Ce témoin n’utilise ni la base ni le worker de Luigi.

Créer `/etc/luigi-witness.env` protégé en lecture avec :

```dotenv
LUIGI_READINESS_URL=https://luigi.example.com/api/ready
WITNESS_DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/...
```

Activer `systemctl enable --now luigi-witness.timer`. Le témoin vérifie toutes les minutes et signale les changements de disponibilité via son propre webhook. Un échec d’envoi ne marque pas l’alerte comme livrée : le prochain passage réessaie. Surveiller aussi ce service depuis l’hébergeur du témoin. Un service externe de vérification HTTPS de `/api/ready` peut remplir le même rôle.

Ce dépôt fournit les scripts et unités ; leur copie, leurs variables et l’activation sur la machine indépendante doivent être réalisées lors du déploiement.

## Vérification

`npm test` exécute les tests sans infrastructure. Définir `TEST_DATABASE_URL` sur une base **jetable dont le nom finit par `_test`**, avec un compte autorisé à créer des bases, pour inclure les tests PostgreSQL. Chaque suite crée puis supprime sa propre base isolée : migrations, transactions interrompues, reprise, exclusion concurrente, jeton de bail périmé, déduplication et isolation entre serveurs. Ne pas utiliser une base réelle pour ces tests. Le collecteur se vérifie avec `python3 -m unittest discover -s tests -p 'test_*.py'`.
