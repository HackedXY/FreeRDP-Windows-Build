#!/usr/bin/env bash
# Contrôles AVANT la mise en service, à lancer sur le VPS depuis sbs-medigest/.
# N'affiche aucun secret. Code de sortie ≠ 0 si un contrôle bloquant échoue.
set -uo pipefail
cd "$(dirname "$0")/../.."
FAIL=0; WARN=0
ok()   { echo "  ✔ $*"; }
ko()   { echo "  ✖ $*"; FAIL=$((FAIL+1)); }
warn() { echo "  ⚠ $*"; WARN=$((WARN+1)); }

echo "== Outils"
if command -v docker >/dev/null; then
  DV=$(docker version --format '{{.Server.Version}}' 2>/dev/null || true)
  [[ -n "$DV" ]] && ok "docker $DV (démon actif)" || ko "démon Docker injoignable (systemctl start docker)"
else ko "docker absent"; fi
CV=$(docker compose version --short 2>/dev/null || echo 0)
if [[ "$(printf '%s\n2.24.0\n' "$CV" | sort -V | head -1)" == "2.24.0" ]]; then ok "docker compose $CV"; else ko "docker compose ≥ 2.24 requis (trouvé : $CV)"; fi

echo "== Fichier .env"
if [[ ! -f .env ]]; then ko ".env absent (lancer deploy/scripts/generate-secrets.sh)"; else
  PERM=$(stat -c %a .env); [[ "$PERM" == 600 ]] && ok ".env en 600" || ko ".env doit être en 600 (actuel : $PERM)"
  set -a; source .env; set +a
  for v in DOMAIN ACME_EMAIL DB_ADMIN_PASSWORD OWNER_DB_PASSWORD APP_DB_PASSWORD BACKUP_DB_PASSWORD DATA_ENCRYPTION_KEY AUDIT_HMAC_KEY BACKUP_TARGET; do
    [[ -n "${!v:-}" ]] && ok "$v défini" || ko "$v manquant"
  done
  for k in DATA_ENCRYPTION_KEY AUDIT_HMAC_KEY; do
    n=$(printf '%s' "${!k:-}" | base64 -d 2>/dev/null | wc -c); [[ "$n" -eq 32 ]] && ok "$k : 32 octets" || ko "$k doit faire 32 octets en base64 (actuel : $n)"
  done
  [[ "${DATA_ENCRYPTION_KEY:-a}" != "${AUDIT_HMAC_KEY:-a}" ]] && ok "clés de chiffrement et d'audit distinctes" || ko "DATA_ENCRYPTION_KEY et AUDIT_HMAC_KEY doivent être différentes"
  PWS=("${DB_ADMIN_PASSWORD:-}" "${OWNER_DB_PASSWORD:-}" "${APP_DB_PASSWORD:-}" "${BACKUP_DB_PASSWORD:-}")
  [[ $(printf '%s\n' "${PWS[@]}" | sort -u | wc -l) -eq 4 ]] && ok "mots de passe PostgreSQL distincts" || ko "les 4 mots de passe PostgreSQL doivent être distincts"
  for p in "${PWS[@]}"; do [[ ${#p} -ge 20 && "$p" =~ ^[A-Za-z0-9]+$ ]] || { ko "mot de passe PostgreSQL trop court ou avec caractères non sûrs pour une URL"; break; }; done
  [[ "${BACKUP_TARGET:-}" == rclone:* ]] && ok "sauvegardes vers un stockage distant" || ko "BACKUP_TARGET doit être rclone:… (hors serveur)"
  [[ -z "${ADMIN_PASSWORD:-}" ]] && warn "ADMIN_PASSWORD vide : le mot de passe initial sera écrit dans les journaux du service migrate"
  [[ "${BACKUP_REMOTE_PRUNE:-off}" == "on" ]] && warn "BACKUP_REMOTE_PRUNE=on : le serveur supprimera d'anciennes sauvegardes (recommandé : off + verrouillage d'objets, docs/SAUVEGARDES.md)" || ok "le serveur ne supprime aucune sauvegarde (rétention par le stockage)"
  IDLE="${SESSION_IDLE_MINUTES:-30}"; [[ "$IDLE" =~ ^[0-9]+$ && "$IDLE" -ge 5 && "$IDLE" -le 120 ]] && ok "déconnexion après ${IDLE} min d'inactivité" || warn "SESSION_IDLE_MINUTES=${IDLE} : valeur inhabituelle (5 à 120 recommandé)"
fi

echo "== Secrets de sauvegarde"
if [[ -f secrets/backup-public.pem ]] && openssl pkey -pubin -in secrets/backup-public.pem -noout 2>/dev/null; then ok "clé publique de sauvegarde valide"; else ko "secrets/backup-public.pem absent ou invalide"; fi
if grep -rqs "PRIVATE KEY" secrets/ 2>/dev/null; then ko "une CLÉ PRIVÉE est présente dans secrets/ : retirez-la du serveur"; else ok "aucune clé privée sur le serveur"; fi
if [[ -f secrets/rclone.env ]]; then
  [[ "$(stat -c %a secrets/rclone.env)" == 600 ]] && ok "secrets/rclone.env en 600" || ko "secrets/rclone.env doit être en 600"
  REMOTE=$(printf '%s' "${BACKUP_TARGET:-}" | cut -d: -f2 | tr '[:lower:]' '[:upper:]')
  grep -q "^RCLONE_CONFIG_${REMOTE}_TYPE=" secrets/rclone.env && ok "stockage « ${REMOTE,,} » configuré" || ko "RCLONE_CONFIG_${REMOTE}_TYPE absent de secrets/rclone.env"
else ko "secrets/rclone.env absent"; fi
git ls-files --error-unmatch .env secrets 2>/dev/null && ko "des secrets sont suivis par git !" || ok "aucun secret suivi par git"

echo "== Réseau"
PUB=$(curl -s -m 5 https://api.ipify.org || true)
DNS=$(getent ahostsv4 "${DOMAIN:-invalid.}" 2>/dev/null | awk '{print $1; exit}')
if [[ -z "$DNS" ]]; then ko "le domaine ${DOMAIN:-?} ne résout pas"; elif [[ -n "$PUB" && "$DNS" != "$PUB" ]]; then ko "${DOMAIN} → $DNS mais ce serveur est $PUB"; else ok "${DOMAIN:-?} → ${DNS}"; fi
for port in 80 443; do
  if ss -ltn "( sport = :$port )" 2>/dev/null | grep -q LISTEN && ! docker compose ps caddy 2>/dev/null | grep -q Up; then ko "port $port déjà utilisé par un autre service"; else ok "port $port disponible"; fi
done
if command -v ufw >/dev/null && ufw status 2>/dev/null | grep -q "Status: active"; then
  ok "pare-feu ufw actif"
  ufw status | grep -E "^(5432|4000|5173)" && ko "ports internes ouverts dans ufw (5432/4000/5173)" || ok "aucun port interne ouvert (5432/4000/5173)"
else warn "pare-feu ufw inactif (voir deploy/scripts/setup-vps.sh)"; fi

echo "== Séparation des secrets"
CFG=$(docker compose config 2>/dev/null)
if [[ -n "$CFG" ]]; then
  n=$(printf '%s\n' "$CFG" | grep -c 'AUDIT_HMAC_KEY:'); [[ "$n" -eq 1 ]] && ok "clé HMAC d'audit transmise au seul service applicatif" || ko "AUDIT_HMAC_KEY présente dans $n services (attendu : 1, app)"
  n=$(printf '%s\n' "$CFG" | grep -c 'DATA_ENCRYPTION_KEY:'); [[ "$n" -eq 1 ]] && ok "clé de chiffrement médical transmise au seul service applicatif" || ko "DATA_ENCRYPTION_KEY présente dans $n services (attendu : 1, app)"
  printf '%s\n' "$CFG" | grep -q 'OWNER_MFA_REQUIRED: "true"' && ok "double authentification obligatoire pour le propriétaire" || ko "OWNER_MFA_REQUIRED doit valoir true"
fi

echo "== Configuration Docker Compose"
docker compose config -q 2>/dev/null && ok "docker-compose.yml valide avec ce .env" || ko "docker compose config en erreur"
docker compose config 2>/dev/null | grep -qE 'published: "?(5432|4000)"?' && ko "un port interne est publié" || ok "seuls 80/443 sont publiés (Caddy)"

echo
echo "Résultat : $FAIL erreur(s), $WARN avertissement(s)."
[[ $FAIL -eq 0 ]]
