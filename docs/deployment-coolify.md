# Déployer Luigi dans ton installation Coolify

Ce guide correspond à tes ressources existantes : `luigi-database` et `luigi:main`, avec **Nixpacks pour le web**. Une seule ressource supplémentaire est nécessaire sur ce serveur : `luigi-worker`.

| Ressource | Action | Rôle |
| --- | --- | --- |
| `luigi-database` | Conserver | PostgreSQL : données, files de tâches, historique |
| `luigi:main` | Redéployer avec le nouveau code | Interface et API, port interne 3011 |
| `luigi-worker` | Créer une application depuis le même dépôt Git | Migrations au démarrage, puis supervision et traitements continus |
| Témoin externe | Configurer hors de ce VPS | Alerter si Luigi, son worker ou son hébergement devient indisponible |

Le worker est un processus permanent. Il n'a ni domaine ni serveur HTTP. Dans ce parcours, Coolify le supervise ; l'unité systemd `luigi-worker.service` du guide générique n'est pas à installer.

## 1. Préparer le code et la sauvegarde

1. Dans `luigi:main`, désactiver temporairement les déploiements automatiques avant de publier le code. Faire de même sur le futur worker pendant la bascule, pour contrôler l'ordre des déploiements.
2. Envoyer sur la branche Git suivie par Coolify les modifications de fiabilité, **y compris** `deploy/Dockerfile.worker`, `scripts/register.mjs`, `src/worker.ts`, `drizzle/0017_reliability.sql` et les métadonnées Drizzle. Un redéploiement d'un ancien commit ne contient pas ces fichiers.
3. Dans `luigi-database`, lancer une sauvegarde PostgreSQL depuis l'onglet de sauvegarde et vérifier sa réussite. Conserver la sauvegarde et la référence du commit actuellement déployé.
4. Dans `luigi-database` → **Configuration → General**, relever l'URL interne PostgreSQL. La valeur `DATABASE_URL` du web doit déjà correspondre à cette base ; réutiliser exactement cette valeur pour le worker.

Pour publier le code depuis le terminal local, après avoir désactivé les déploiements automatiques et vérifié les modifications avec `git status` et `git diff` :

```powershell
Set-Location 'C:\Users\Wolfgang\Documents\Code\Monitoring_Apps_Thermidor_Web_Agency\Luigi'
git add .
git commit -m "feat: add durable monitoring worker and Coolify deployment"
git push origin main
```

Arrêter à la première erreur ; poursuivre uniquement après la réussite du push. Ces commandes publient l'ensemble des changements de cette mise à jour : envoyer le seul Dockerfile ne suffit pas, car il dépend du worker et des nouvelles migrations.

Vérifier ensuite dans le dépôt Git distant, sur `main`, que `deploy/Dockerfile.worker`, `src/worker.ts` et `drizzle/0017_reliability.sql` sont présents. Le commit sélectionné dans les logs du prochain déploiement Coolify doit correspondre au nouveau commit.

La mention `localhost` dans la liste des ressources est le nom du serveur Coolify. Pour PostgreSQL, utiliser le nom de conteneur fourni par l'URL interne, pas `localhost` ni `127.0.0.1`. Placer le worker sur le même serveur **et la même destination/réseau Docker** que le web et la base. Aucun port PostgreSQL public n'est nécessaire. [Réseau Coolify](https://coolify.io/docs/core/networking-in-coolify)

## 2. Préparer `luigi-worker`, sans encore le déployer

Depuis le projet et l'environnement qui contiennent tes deux ressources :

1. Cliquer **+ New**.
2. Choisir la même source Git/GitHub que pour `luigi:main` et sélectionner le même dépôt et la même branche, `main` si c'est bien la branche suivie par le web.
3. Créer une **Application**, avec le Build Pack **Dockerfile**, depuis le dépôt Git. Ne pas choisir le mode « Dockerfile sans Git » : le worker a besoin des fichiers du dépôt.
4. Renseigner les champs suivants.

| Champ | Valeur |
| --- | --- |
| Name | `luigi-worker` |
| Server / Destination | Identiques à `luigi:main` |
| Build Pack | `Dockerfile` |
| Base Directory | `/`, la racine du dépôt contenant `package.json` |
| Dockerfile Location | `/deploy/Dockerfile.worker` |
| Docker Build Stage | Vide |
| Domains | Vide : retirer le domaine généré s'il y en a un |
| Ports Mappings | Vide |
| Ports Exposes | Vide si accepté ; si Coolify impose une valeur, laisser sa valeur par défaut sans domaine ni mapping : le worker n'écoute sur aucun port |
| Healthcheck | Désactivé pour cette ressource sans HTTP |
| Pre / Post Deployment Command | Vides |
| Réplicas | Un seul pour cette installation |

Le Dockerfile fournit les commandes de construction et de démarrage ; ne pas lui substituer `npm start`. Il utilise Node.js 24, garde TypeScript disponible à l'exécution et ne construit pas le frontend. La politique de redémarrage du conteneur doit être `unless-stopped` ou `always`, si ton interface expose ce réglage. [Déploiement Dockerfile dans Coolify](https://coolify.io/docs/applications/builds/dockerfile)

Dans **Environment Variables**, recopier les valeurs de `luigi:main` :

| Variable | Valeur à reprendre |
| --- | --- |
| `DATABASE_URL` | Même URL interne PostgreSQL |
| `INTEGRATION_ENCRYPTION_KEY` | Exactement la même clé, indispensable pour lire les intégrations chiffrées |
| `BETTER_AUTH_URL` | URL publique du web, utilisée dans les liens des notifications |
| `DISCORD_WEBHOOK_URL` | Même webhook si Discord est configuré |
| `NEXT_PUBLIC_VAPID_PUBLIC_KEY` | Même clé publique si Web Push est configuré |
| `VAPID_PRIVATE_KEY` | Même clé privée si Web Push est configuré |
| `VAPID_SUBJECT` | Même valeur si Web Push est configuré |
| `DEPENDENCY_SCAN_INTERVAL_HOURS` | Même valeur personnalisée, sinon 24 |
| `DEPENDENCY_SCAN_BATCH_SIZE` | Même valeur personnalisée, sinon 3 |

Pour le worker, cocher **Runtime Variable** et décocher **Build Variable** pour ces variables : sa construction n'a pas besoin de la base ou des secrets. Conserver les clés existantes ; ne pas en générer de nouvelles. Le préfixe `NEXT_PUBLIC_` n'impose pas ici une variable de build, puisque ce conteneur ne construit aucun navigateur. [Variables Coolify](https://coolify.io/docs/applications/configuration/environment-variables)

## 3. Vérifier la configuration du web Nixpacks

Dans `luigi:main` → **Configuration → General** :

| Champ | Valeur |
| --- | --- |
| Build Pack | Garder `Nixpacks` |
| Install Command | `npm ci --include=dev` |
| Build Command | `npm run build` |
| Start Command | `npm start` |
| Ports Exposes | `3011` |
| Is it a static site? | Désactivé |
| Domains | Garder le domaine public actuel |

Conserver les variables actuelles du web, notamment `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `DATABASE_URL`, les clés d'intégrations et VAPID. `DATABASE_URL` doit être disponible pour le build Next.js actuel et à l'exécution ; `NEXT_PUBLIC_VAPID_PUBLIC_KEY` doit aussi être disponible au build. Si les hooks ou la Start Command du web lancent déjà les migrations, en retirer uniquement cette partie : **le worker sera l'unique responsable des migrations** dans ce parcours.

Dans **Configuration → Healthcheck**, désactiver temporairement le contrôle pour le prochain déploiement. Il sera activé après vérification du worker. [Champs Nixpacks](https://coolify.io/docs/applications/builds/nixpacks/deploy)

## 4. Effectuer la bascule, dans cet ordre

Prévoir une courte interruption de l'interface pendant cette première migration.

1. Désactiver l'ancien appel périodique à `POST /api/cron/monitor`, s'il existe dans les Scheduled Tasks de Coolify, un cron système ou un service externe. Ne pas désactiver les timers des agents VPS.
2. Dans `luigi:main`, cliquer **Stop**. Garder `luigi-database` démarrée. L'ancien web ne doit plus écrire pendant la migration du modèle agents/serveurs.
3. Dans `luigi-worker`, cliquer **Deploy** sur le nouveau commit.
4. Dans ses **Logs**, attendre `Migrations PostgreSQL appliquées.`. Cette ligne précède le démarrage du worker. Une migration en erreur empêche le worker de démarrer : corriger l'erreur avant de poursuivre. Un worker sain peut ensuite rester silencieux.
5. Dans `luigi:main`, cliquer **Deploy** sur **le même commit** et attendre la fin du build et du démarrage.
6. Ouvrir `http://qchlmcqgfp4thdasele3coyj.135.125.131.49.sslip.io/api/ready` avec l'URL publique actuelle. Attendre jusqu'à une minute après démarrage du worker pour sa première évaluation.

Résultat attendu : HTTP **200**, avec notamment :

```json
{
  "status": "ready",
  "ready": true,
  "database": true,
  "scheduler": true,
  "backlog": true
}
```

Le champ `backlog: true` signifie que la vérification du retard est satisfaite. Une réponse 503 avec `database: false` invite à vérifier la connexion et les migrations ; `scheduler: false` indique des heartbeats manquants ou anciens ; `backlog: false` indique des tâches excessivement en retard. Consulter les logs du worker. Le statut Coolify « Running » seul ne valide pas la supervision.

Dans ce parcours, ne pas lancer manuellement `db:push`, `db:generate` ou une migration depuis l'ancien conteneur. Le Dockerfile exécute les migrations versionnées avec le code neuf, puis le worker. Le hook Pre-deployment de Coolify s'exécute dans **l'ancien** conteneur, ce qui ne garantit pas la présence de la nouvelle migration. [Fonctionnement des hooks](https://coolify.io/docs/applications/builds/dockerfile)

## 5. Activer le contrôle de santé de `luigi:main`

Quand `/api/ready` est valide, activer le Healthcheck du **web**, pas celui du worker. Avec les versions de Coolify proposant le type **CMD**, utiliser :

```sh
node -e "fetch('http://127.0.0.1:3011/api/ready',{signal:AbortSignal.timeout(8000)}).then(r=>process.exit(r.status===200?0:1)).catch(()=>process.exit(1))"
```

Réglages conseillés pour cette installation : intervalle **15 s**, timeout **10 s**, retries **3**, start period **60 s**. Enregistrer, activer le contrôle puis redémarrer le web pour appliquer sa configuration au conteneur.

Si ton Coolify ne propose que le type HTTP, vérifier d'abord dans le Terminal du web que `command -v curl || command -v wget` trouve un client, puis renseigner `GET`, `http`, `localhost`, port `3011`, chemin `/api/ready`. Un client absent rend ce contrôle invalide ; utiliser le type CMD ci-dessus si disponible, ou installer un client dans l'image Nixpacks avant de l'activer.

Avec Traefik, une application déclarée unhealthy peut être retirée du routage : en cas de panne worker, le domaine peut donc afficher une erreur proxy au lieu du JSON 503. Le témoin externe doit considérer toute réponse différente de 200 ou absence de réponse comme une panne. [Health checks Coolify](https://coolify.io/docs/applications/configuration/health-checks)

## 6. Mettre à jour les agents déjà installés

Cette opération concerne chacun des VPS déjà enrôlés. Elle se fait dans le **terminal SSH du VPS**, pas dans le terminal du conteneur web. Ne pas relancer la commande d'enrôlement de Luigi : conserver `/etc/luigi-agent.env`, les identifiants et l'historique.

Depuis une copie du nouveau dépôt sur ton poste, envoyer les deux scripts au VPS concerné, en remplaçant `UTILISATEUR@VPS` :

```sh
scp agent/luigi_agent.py agent/luigi_runtime_collector.py UTILISATEUR@VPS:/tmp/
```

Puis, en SSH sur ce VPS :

```sh
sudo systemctl stop luigi-agent.timer
sudo systemctl stop luigi-agent.service luigi-runtime.service
sudo install -o root -g root -m 0755 /tmp/luigi_agent.py /opt/luigi-agent/luigi_agent.py
sudo install -o root -g root -m 0755 /tmp/luigi_runtime_collector.py /opt/luigi-agent/luigi_runtime_collector.py
sudo systemctl start luigi-agent.service
sudo systemctl start luigi-agent.timer
sudo journalctl -u luigi-runtime.service -u luigi-agent.service -n 50 --no-pager
```

L'unité agent existante déclenche le collecteur runtime avant d'envoyer le rapport. Vérifier ensuite une nouvelle collecte dans **Luigi → Paramètres → VPS**. Les anciens scripts restent compatibles temporairement, mais leurs données runtime ne fournissent pas les nouvelles garanties d'exhaustivité.

## 7. Ajouter le témoin indépendant

Configurer un service de surveillance **hébergé ailleurs que sur ce VPS Coolify** :

- Type : vérification HTTP de l'URL publique `http://qchlmcqgfp4thdasele3coyj.135.125.131.49.sslip.io/api/ready` ; utiliser le domaine HTTPS réel si tu en configures un.
- Fréquence : 60 secondes.
- Résultat sain : HTTP 200 ; timeout ou autre statut = indisponible.
- Alertes : canal configuré directement dans ce service externe, sans passer par Luigi.
- Notifier les pannes et les rétablissements ; vérifier que les alertes arrivent.

Si tu disposes d'une seconde machine indépendante, les fichiers `scripts/watchdog.mjs`, `deploy/luigi-witness.service` et `deploy/luigi-witness.timer` fournissent une alternative à installer selon le [guide de fiabilité](reliability.md#témoin-externe-indépendant). Un témoin sur le même VPS ne détecterait pas sa propre disparition.

## 8. Vérifier la reprise et les prochains déploiements

1. Confirmer que les trois ressources Coolify sont démarrées et que `/api/ready` est valide.
2. Dans Luigi, demander un contrôle d'application : il doit quitter l'attente et produire une mesure récente. Vérifier une collecte VPS et le journal **Paramètres → Intégrations → Supervision et livraison**.
3. Pendant une fenêtre de test, arrêter uniquement `luigi-worker`. Après expiration des heartbeats (45 secondes), le contrôle doit devenir indisponible ; le témoin externe doit alerter au passage suivant. Redémarrer le worker et vérifier le retour à 200 ainsi que la reprise des contrôles. Un test aussi court peut ne pas montrer la reprise d'un bail long : les jobs interrompus redeviennent réservables à l'expiration de leur bail, jusqu'à environ 10 min 15 s pour un scan.
4. Laisser l'ancien cron désactivé : le worker assure la planification.
5. Pour les prochaines versions, déployer le **même commit sur le worker et le web**. Si une migration modifie le schéma, garder un déploiement coordonné : arrêter web et worker, sauvegarder, déployer le worker/migrations, puis le web. Ne pas laisser deux déploiements automatiques concurrents décider de cet ordre.

Si la bascule échoue, conserver le diagnostic et la sauvegarde. Revenir au seul ancien commit après une migration de schéma ne suffit pas forcément : pour restaurer intégralement l'ancien système, arrêter les processus qui écrivent, restaurer la sauvegarde PostgreSQL correspondante, puis redéployer l'ancien code.

## Erreur « lstat /artifacts/…/deploy: no such file or directory »

Coolify ne trouve pas le dossier contenant le Dockerfile dans le contexte de construction. Vérifier d'abord que le nouveau commit a bien été poussé et que le déploiement utilise ce commit, ce dépôt et cette branche. Un dossier `deploy/` marqué `??` dans `git status` existe uniquement dans les fichiers locaux : il n'est pas encore inclus dans un commit.

Pour ce dépôt, conserver **Base Directory = `/`** et **Dockerfile Location = `/deploy/Dockerfile.worker`**. Après publication du code, lancer un nouveau **Deploy** du worker ; un simple Restart réutiliserait une image existante. Si les fichiers sont présents dans le commit mais que l'erreur persiste, comparer le dépôt, la branche, le SHA et le Base Directory affichés dans les Debug Logs avec ceux attendus.
