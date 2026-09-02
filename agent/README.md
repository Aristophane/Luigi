# Agent VPS Luigi

L’agent cible Ubuntu Server 24.04 et utilise uniquement Python 3 et les commandes système déjà présentes. Il collecte en lecture seule puis initie une requête sortante vers Luigi toutes les cinq minutes.

## Installation

1. Dans Luigi, ouvre **Paramètres → VPS Ubuntu** et crée un jeton agent.
2. Transfère le dossier `agent/` de ce dépôt sur le VPS.
3. Depuis la racine du dépôt transféré, exécute la commande affichée par Luigi.
4. Saisis le jeton lorsque le script le demande. Il n’est pas ajouté à l’historique du shell.

Le script crée :

- le compte système sans shell `luigi-agent` ;
- `/opt/luigi-agent/luigi_agent.py` ;
- `/etc/luigi-agent.env`, lisible uniquement par root et le groupe agent ;
- un service `oneshot` systemd durci ;
- un timer systemd toutes les cinq minutes avec un léger jitter.

Commandes utiles :

```bash
sudo systemctl status luigi-agent.service
sudo systemctl list-timers luigi-agent.timer
sudo journalctl -u luigi-agent.service --since today
sudo systemctl start luigi-agent.service
```

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

Le jeton, les journaux système, les processus et le contenu des fichiers de configuration ne sont jamais inclus dans le rapport.
