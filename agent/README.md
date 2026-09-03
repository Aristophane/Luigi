# Agent VPS Luigi

L’agent prend en charge Ubuntu et Debian. Il utilise Python 3 et les commandes système natives, collecte en lecture seule puis initie une requête HTTPS sortante vers Luigi toutes les cinq minutes.

## Installation

1. Dans Luigi, ouvre **Paramètres → VPS** et sélectionne **Connecter mon VPS**.
2. Copie l’unique commande affichée et colle-la dans le terminal du VPS.
3. Laisse la page ouverte : elle confirmera automatiquement l’arrivée du premier rapport.

La commande télécharge l’installateur depuis ton instance Luigi. Elle contient un code aléatoire valable dix minutes et utilisable une seule fois. Le jeton permanent est remis directement à l’agent via HTTPS et n’apparaît jamais dans le terminal ou l’interface.

Le script crée :

- le compte système sans shell `luigi-agent` ;
- `/opt/luigi-agent/luigi_agent.py` ;
- `/etc/luigi-agent.env`, lisible uniquement par root et le groupe agent ;
- un service `oneshot` systemd durci ;
- un timer systemd toutes les cinq minutes avec un léger jitter.

Avant toute modification, il détecte `/etc/os-release`, accepte uniquement Ubuntu ou Debian, puis vérifie systemd, `apt-get`, Python 3, le DNS et la connexion TLS vers Luigi.

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
