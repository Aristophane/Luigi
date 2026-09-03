#!/usr/bin/env bash
set -Eeuo pipefail

SERVER=""
ENROLLMENT_CODE=""
ALLOW_INSECURE_HTTP="0"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --server) SERVER="${2:-}"; shift 2 ;;
    --code) ENROLLMENT_CODE="${2:-}"; shift 2 ;;
    --allow-insecure-http) ALLOW_INSECURE_HTTP="1"; shift ;;
    *) echo "Option inconnue : $1" >&2; exit 2 ;;
  esac
done

fail() {
  echo >&2
  echo "Installation interrompue : $1" >&2
  exit 1
}

step() {
  printf '\n[%s/5] %s\n' "$1" "$2"
}

if [[ "${EUID}" -ne 0 ]]; then
  fail "relance la commande avec sudo."
fi
if [[ ! "${ENROLLMENT_CODE}" =~ ^luigi_enroll_[A-Za-z0-9_-]{40,}$ ]]; then
  fail "le code d’enrôlement est invalide. Génère une nouvelle commande dans Luigi."
fi

SERVER="${SERVER%/}"
if [[ "${ALLOW_INSECURE_HTTP}" == "0" && ! "${SERVER}" =~ ^https://[^[:space:]]+$ ]]; then
  fail "l’adresse de Luigi doit utiliser HTTPS."
fi
if [[ "${ALLOW_INSECURE_HTTP}" == "1" && ! "${SERVER}" =~ ^https?://[^[:space:]]+$ ]]; then
  fail "l’adresse de Luigi doit utiliser HTTP(S)."
fi

step 1 "Vérification du VPS"
[[ -r /etc/os-release ]] || fail "impossible d’identifier la distribution Linux."
# shellcheck disable=SC1091
. /etc/os-release
case "${ID:-}" in
  ubuntu|debian) ;;
  *) fail "${PRETTY_NAME:-Cette distribution} n’est pas encore prise en charge. Luigi accepte Ubuntu et Debian." ;;
esac
command -v systemctl >/dev/null 2>&1 || fail "systemd est requis pour exécuter l’agent."
command -v apt-get >/dev/null 2>&1 || fail "apt-get est requis sur Ubuntu et Debian."
printf '%s détecté · %s\n' "${PRETTY_NAME:-$ID}" "$(uname -m)"

missing_packages=()
command -v python3 >/dev/null 2>&1 || missing_packages+=(python3)
[[ -r /etc/ssl/certs/ca-certificates.crt ]] || missing_packages+=(ca-certificates)
if ! command -v curl >/dev/null 2>&1 && ! command -v wget >/dev/null 2>&1; then
  missing_packages+=(curl)
fi
if (( ${#missing_packages[@]} > 0 )); then
  echo "Installation des prérequis manquants : ${missing_packages[*]}"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y --no-install-recommends "${missing_packages[@]}"
fi

download() {
  local url="$1"
  local destination="$2"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL --connect-timeout 10 --max-time 45 "$url" -o "$destination"
  else
    wget -q --timeout=45 -O "$destination" "$url"
  fi
}

get_url() {
  local url="$1"
  if command -v curl >/dev/null 2>&1; then
    curl -fsS --connect-timeout 10 --max-time 30 "$url"
  else
    wget -q --timeout=30 -O- "$url"
  fi
}

enroll() {
  local url="$1"
  if command -v curl >/dev/null 2>&1; then
    curl -fsS --connect-timeout 10 --max-time 30 -X POST \
      -H "Authorization: Bearer ${ENROLLMENT_CODE}" \
      -H "Accept: application/json" \
      "$url"
  else
    wget -q --timeout=30 -O- \
      --header="Authorization: Bearer ${ENROLLMENT_CODE}" \
      --header="Accept: application/json" \
      --post-data='' \
      "$url"
  fi
}

step 2 "Connexion sécurisée à Luigi"
if ! get_url "${SERVER}/api/health" >/dev/null; then
  fail "le VPS ne parvient pas à joindre ${SERVER}. Vérifie le DNS, le certificat TLS et le port 443."
fi

temporary_directory="$(mktemp -d)"
trap 'rm -rf -- "$temporary_directory"' EXIT
download "${SERVER}/install/vps/agent.py" "${temporary_directory}/luigi_agent.py" \
  || fail "impossible de télécharger l’agent."
download "${SERVER}/install/vps/service" "${temporary_directory}/luigi-agent.service" \
  || fail "impossible de télécharger le service systemd."
download "${SERVER}/install/vps/timer" "${temporary_directory}/luigi-agent.timer" \
  || fail "impossible de télécharger le timer systemd."

step 3 "Enrôlement de l’agent"
if ! enrollment_response="$(enroll "${SERVER}/api/agent/v1/enroll")"; then
  fail "le code est invalide, expiré ou déjà utilisé. Génère une nouvelle commande dans Luigi."
fi
if ! parsed_credentials="$(printf '%s' "$enrollment_response" | python3 -c 'import json, sys; data=json.load(sys.stdin); print(data["agentId"], data["token"], data["endpoint"], sep="\t")')"; then
  fail "Luigi a renvoyé une réponse d’enrôlement illisible."
fi
IFS=$'\t' read -r AGENT_ID LUIGI_TOKEN ENDPOINT <<< "$parsed_credentials"
[[ "${AGENT_ID}" =~ ^[0-9a-fA-F-]{36}$ ]] || fail "Luigi a renvoyé un identifiant d’agent invalide."
[[ "${LUIGI_TOKEN}" =~ ^luigi_vps_[A-Za-z0-9_-]{40,}$ ]] || fail "Luigi a renvoyé un jeton invalide."

step 4 "Installation du service"
id -u luigi-agent >/dev/null 2>&1 \
  || useradd --system --home-dir /var/lib/luigi-agent --create-home --shell /usr/sbin/nologin luigi-agent
install -d -o root -g root -m 0755 /opt/luigi-agent
install -o root -g root -m 0755 "${temporary_directory}/luigi_agent.py" /opt/luigi-agent/luigi_agent.py

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
unset ENROLLMENT_CODE LUIGI_TOKEN enrollment_response parsed_credentials

install -o root -g root -m 0644 "${temporary_directory}/luigi-agent.service" /etc/systemd/system/luigi-agent.service
install -o root -g root -m 0644 "${temporary_directory}/luigi-agent.timer" /etc/systemd/system/luigi-agent.timer
systemctl daemon-reload
systemctl enable --now luigi-agent.timer >/dev/null

step 5 "Premier rapport"
if ! systemctl start luigi-agent.service; then
  echo "Le service est installé, mais le premier rapport a échoué." >&2
  echo "Diagnostic : sudo journalctl -u luigi-agent.service -n 50 --no-pager" >&2
  exit 1
fi

echo
echo "VPS connecté à Luigi. Le prochain rapport sera envoyé dans environ cinq minutes."
