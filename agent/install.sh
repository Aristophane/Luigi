#!/usr/bin/env bash
set -euo pipefail

ENDPOINT=""
AGENT_ID=""
ALLOW_INSECURE_HTTP="0"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --endpoint) ENDPOINT="${2:-}"; shift 2 ;;
    --agent-id) AGENT_ID="${2:-}"; shift 2 ;;
    --allow-insecure-http) ALLOW_INSECURE_HTTP="1"; shift ;;
    *) echo "Option inconnue : $1" >&2; exit 2 ;;
  esac
done

if [[ "${EUID}" -ne 0 ]]; then
  echo "Exécute ce script avec sudo." >&2
  exit 1
fi
if [[ ! "${AGENT_ID}" =~ ^[0-9a-fA-F-]{36}$ ]]; then
  echo "Identifiant d’agent invalide." >&2
  exit 2
fi
if [[ "${ALLOW_INSECURE_HTTP}" == "0" && ! "${ENDPOINT}" =~ ^https:// ]]; then
  echo "L’endpoint doit utiliser HTTPS. Ajoute --allow-insecure-http uniquement pour un test local." >&2
  exit 2
fi
if [[ "${ALLOW_INSECURE_HTTP}" == "1" && ! "${ENDPOINT}" =~ ^https?:// ]]; then
  echo "Endpoint HTTP(S) invalide." >&2
  exit 2
fi

read -r -s -p "Jeton agent affiché par Luigi : " LUIGI_TOKEN
echo
if [[ ! "${LUIGI_TOKEN}" =~ ^luigi_vps_[A-Za-z0-9_-]{40,}$ ]]; then
  echo "Format de jeton invalide." >&2
  exit 2
fi

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
id -u luigi-agent >/dev/null 2>&1 || useradd --system --home-dir /var/lib/luigi-agent --create-home --shell /usr/sbin/nologin luigi-agent
install -d -o root -g root -m 0755 /opt/luigi-agent
install -o root -g root -m 0755 "${SCRIPT_DIR}/luigi_agent.py" /opt/luigi-agent/luigi_agent.py

umask 0077
{
  printf 'LUIGI_ENDPOINT=%s\n' "${ENDPOINT}"
  printf 'LUIGI_AGENT_ID=%s\n' "${AGENT_ID}"
  printf 'LUIGI_TOKEN=%s\n' "${LUIGI_TOKEN}"
  printf 'LUIGI_ALLOW_INSECURE_HTTP=%s\n' "${ALLOW_INSECURE_HTTP}"
  printf 'LUIGI_SERVICES=%s\n' "ssh,docker"
} > /etc/luigi-agent.env
chown root:luigi-agent /etc/luigi-agent.env
chmod 0640 /etc/luigi-agent.env
unset LUIGI_TOKEN

install -o root -g root -m 0644 "${SCRIPT_DIR}/luigi-agent.service" /etc/systemd/system/luigi-agent.service
install -o root -g root -m 0644 "${SCRIPT_DIR}/luigi-agent.timer" /etc/systemd/system/luigi-agent.timer
systemctl daemon-reload
systemctl enable --now luigi-agent.timer
systemctl start luigi-agent.service
echo "Agent installé. Vérifie avec : systemctl status luigi-agent.service"
