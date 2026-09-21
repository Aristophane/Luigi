# Agent VPS Luigi

L’agent prend en charge Ubuntu et Debian. Il utilise Python 3 et les commandes système natives. Le rapport de santé, accompagné des signaux d’exécution (arrêts mémoire et redémarrages), est envoyé toutes les cinq minutes et l’inventaire détaillé du disque toutes les six heures.

## Installation

1. Dans Luigi, ouvre **Paramètres → VPS** et sélectionne **Connecter mon VPS**.
2. Copie l’unique commande affichée et colle-la dans le terminal du VPS.
3. Laisse la page ouverte : elle confirmera automatiquement l’arrivée du premier rapport.

La commande télécharge l’installateur depuis ton instance Luigi. Elle contient un code aléatoire valable dix minutes et utilisable une seule fois. Le jeton permanent est remis directement à l’agent via HTTPS et n’apparaît jamais dans le terminal ou l’interface.

Le script crée :

- le compte système sans shell `luigi-agent` ;
- `/opt/luigi-agent/luigi_agent.py` ;
- `/opt/luigi-agent/luigi_storage_collector.py`, collecteur local isolé du réseau ;
- `/opt/luigi-agent/luigi_runtime_collector.py`, collecteur d’exécution isolé du réseau ;
- `/etc/luigi-agent.env`, lisible uniquement par root et le groupe agent ;
- trois services `oneshot` systemd durcis ;
- un timer de santé toutes les cinq minutes et un timer d’inventaire toutes les six heures, avec un léger jitter.

Le collecteur disque s’exécute ponctuellement avec les droits de lecture nécessaires, sans accès réseau, avec une priorité basse et une limite de dix minutes. Il écrit un inventaire assaini dans `/var/lib/luigi-agent/storage.json`. Le service principal, non privilégié, se charge ensuite de l’envoyer à Luigi. Aucun contenu de fichier n’est collecté et Luigi ne peut supprimer aucun fichier à distance.

Le collecteur d’exécution s’exécute juste avant chaque rapport de santé, sans accès réseau et avec les seules capacités de lecture nécessaires. Il lit les métadonnées Docker sur disque (nom, étiquettes Compose, nombre de redémarrages), les compteurs mémoire des cgroups, `systemctl show` pour les services de `LUIGI_SERVICES` et les lignes `oom-kill` du journal noyau. Il n’utilise pas le socket Docker et ne peut donc agir sur aucun conteneur. Il conserve une fenêtre glissante de 24 heures d’événements dans `/var/lib/luigi-agent/runtime.json`, que l’agent joint au rapport tant qu’elle a moins de quinze minutes.

Un dépassement du heap V8 (`Reached heap limit`) arrête Node sans passer par le noyau : il n’apparaît que sous forme de redémarrage. Un arrêt par le noyau n’est attribué à un conteneur que si celui-ci a encore ses métadonnées sur le VPS ; sinon Luigi le signale au niveau du VPS.

Avant toute modification, il détecte `/etc/os-release`, accepte uniquement Ubuntu ou Debian, puis vérifie systemd, `apt-get`, Python 3, le DNS et la connexion TLS vers Luigi.

Commandes utiles :

```bash
sudo systemctl status luigi-agent.service
sudo systemctl list-timers luigi-agent.timer
sudo journalctl -u luigi-agent.service --since today
sudo systemctl start luigi-agent.service
sudo systemctl status luigi-storage.service
sudo systemctl list-timers luigi-storage.timer
sudo journalctl -u luigi-storage.service --since today
sudo systemctl start luigi-storage.service
sudo systemctl status luigi-runtime.service
sudo journalctl -u luigi-runtime.service --since today
```

Pour mettre à jour un agent déjà installé, génère une nouvelle commande depuis **Paramètres → VPS** et relance-la : l’enrôlement remplace le jeton précédent et installe les nouveaux fichiers.

## Configuration facultative

Édite `/etc/luigi-agent.env`, puis redémarre le service :

```dotenv
LUIGI_SERVICES=ssh,docker
LUIGI_BACKUP_STAMP_FILE=/var/lib/backups/last-success
LUIGI_BACKUP_MAX_HOURS=24
```

Le fichier de sauvegarde est un marqueur dont la date de modification correspond à la dernière réussite. En production, l’endpoint Luigi doit utiliser HTTPS. `--allow-insecure-http` est réservé aux tests sur un réseau local maîtrisé.

## Données envoyées

- CPU, charge, mémoire, swap, disque racine et uptime ;
- mises à jour APT disponibles, correctifs de sécurité, paquets retenus et redémarrage requis ;
- état UFW et réglages SSH explicitement définis ;
- services systemd sélectionnés ;
- fraîcheur de sauvegarde si un fichier marqueur est configuré.
- occupation des principaux répertoires Coolify, Docker, bases, journaux, sauvegardes, applications et système ;
- compteur d’arrêts mémoire du noyau depuis le démarrage, mémoire et limite de chaque conteneur ou service suivi, redémarrages automatiques et arrêts mémoire des 24 dernières heures.

Le jeton, les journaux système, la liste des processus et le contenu des fichiers de configuration ne sont jamais inclus dans le rapport. Des lignes du journal noyau, seuls la date, le nom du processus arrêté (par exemple `node`) et sa mémoire résidente sont transmis.
