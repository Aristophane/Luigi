# Confirmation des déploiements

Le worker vérifie les versions déclarées par les hébergeurs toutes les cinq minutes. Le processus web ne planifie pas ces vérifications. Une réponse HTTP 200 d'un site ne constitue pas une preuve de sa version.

Configurer uniquement les applications à lire dans `DEPLOYMENT_SYNC_TARGETS`, au format JSON :

```json
[
  {"applicationUrl":"https://app.example.com/","provider":"coolify","resourceId":"coolify-application-uuid"},
  {"applicationUrl":"https://shop.example.com/","provider":"netlify","siteId":"site-name.netlify.app"},
  {"applicationUrl":"https://admin.example.com/admin","provider":"railway","projectId":"11111111-1111-4111-8111-111111111111","environmentId":"22222222-2222-4222-8222-222222222222","serviceId":"33333333-3333-4333-8333-333333333333","tokenVariable":"RAILWAY_PROJECT_TOKEN"}
]
```

`applicationId` peut remplacer l'URL. Lorsque les deux sont fournis, les deux doivent correspondre. Les chemins d'URL sont conservés : une page `/admin` et un site à la racine peuvent désigner deux applications différentes. Une cible précise évite de confondre ancienne ressource, staging et production dans Coolify.

Variables nécessaires dans le **worker** :

- `DEPLOYMENT_SYNC_TARGETS` et, facultativement, `DEPLOYMENT_SYNC_INTERVAL_SECONDS` (300 par défaut, entre 60 et 3600) ;
- Coolify : `COOLIFY_API_URL` (origine HTTPS) et `COOLIFY_DEPLOYMENT_READ_TOKEN`, avec la permission `read` ;
- Netlify : `NETLIFY_DEPLOYMENT_TOKEN` ;
- Railway : `RAILWAY_PROJECT_TOKEN`, ou le nom indiqué par `tokenVariable` pour un jeton limité à un projet.

Ces secrets restent côté worker. Dans `compose.coolify.apps.yaml`, utiliser les variables `RUNTIME_WORKER_*` correspondantes. Le jeton de réception des événements CI, `DEPLOYMENT_INGEST_SECRET`, reste côté web. Les anciens programmes injectés dans `LUIGI_*_SYNC_CODE_B64` ne sont plus nécessaires.

Le worker vérifie l'identité des ressources, leur dépôt et leur branche lorsqu'ils sont exposés, et refuse les previews, les livraisons échouées et les ressources arrêtées. Netlify est lu via `published_deploy` ; Railway doit exposer une livraison `SUCCESS` active dans le projet, service et environnement configurés. Coolify doit exposer une application démarrée et un déploiement terminé hors pull request.

La vérification renouvelle `verifiedAt` sur l'événement connu, sans créer une entrée à chaque passage ni changer sa date de livraison. Une nouvelle publication Netlify est identifiée par le déploiement et sa date de publication, pour gérer la republication d'une ancienne version. L'interface choisit en priorité l'événement dernièrement confirmé afin de représenter un rollback.

Une confirmation expire après deux heures sans nouvelle vérification. L'événement historique reste visible ; la comparaison courante devient incertaine. Une livraison ancienne, régulièrement confirmée par son hébergeur, reste valable.

Les erreurs par application sont conservées dans le journal des tâches de synchronisation, visible dans **Paramètres → Intégrations**. Les sources valides sont enregistrées même si une autre source échoue. La tâche applique ensuite les reprises habituelles de la file persistante. Les pulsations du worker seules ne confirment pas une vérification d'hébergeur.

Un envoi d'archive par la CLI Railway peut ne contenir aucune référence Git. Luigi vérifie alors le projet, l'environnement, le service, le domaine public et le déploiement actif, mais conserve `commitSha: null`. L'interface indique « commit non communiqué » et ne compare pas ce déploiement au dépôt. Une confirmation du déploiement ne constitue pas une preuve de son commit.

Les événements CI existants restent acceptés par `POST /api/deployments`. `branch` et `environment` optionnels sont contrôlés contre l'application. Un même identifiant avec un SHA ou des attributs incompatibles reçoit HTTP 409. La preuve facultative `verification: {"provider":"coolify","observedAt":"2026-10-28T12:00:00Z"}` doit être ajoutée uniquement après une lecture effective de l'hébergeur. Le worker réutilise cette même ingestion transactionnelle avec son bail.

Références des fournisseurs : [Coolify API](https://coolify.io/docs/api/overview), [Netlify API](https://docs.netlify.com/api-and-cli-guides/api-guides/get-started-with-api/), [Railway API](https://docs.railway.com/integrations/api/manage-deployments).
