#!/usr/bin/env bash
# Génère le fichier .env de production avec des secrets aléatoires.
#   ./deploy/scripts/generate-secrets.sh <domaine> <email-acme> [cible-sauvegarde]
# - N'écrase jamais un .env existant ; droits 600 ; aucun secret affiché à l'écran.
# - Copiez ensuite DATA_ENCRYPTION_KEY, AUDIT_HMAC_KEY et les mots de passe dans un coffre HORS du serveur.
set -euo pipefail
cd "$(dirname "$0")/../.."

DOMAIN="${1:-}"; ACME_EMAIL="${2:-}"; BACKUP_TARGET="${3:-rclone:distant:sbs-sauvegardes}"
if [[ -z "$DOMAIN" || -z "$ACME_EMAIL" ]]; then
  echo "Usage : $0 <domaine, ex. sbs.mondomaine.gn> <email pour Let's Encrypt> [cible rclone]" >&2; exit 2
fi
[[ "$DOMAIN" =~ ^([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$ ]] || { echo "Domaine invalide : $DOMAIN" >&2; exit 2; }
[[ "$ACME_EMAIL" =~ ^[^@[:space:]]+@[^@[:space:]]+\.[a-zA-Z]{2,}$ ]] || { echo "E-mail invalide" >&2; exit 2; }
[[ "$BACKUP_TARGET" == rclone:* ]] || { echo "La cible de sauvegarde doit être distante (rclone:…)" >&2; exit 2; }
if [[ -e .env ]]; then echo ".env existe déjà : abandon (aucun secret écrasé)." >&2; exit 1; fi
command -v openssl >/dev/null || { echo "openssl requis" >&2; exit 2; }

key32() { openssl rand -base64 32 | tr -d '\n'; }                       # clé de 32 octets en base64
alnum() { openssl rand -base64 64 | tr -dc 'A-Za-z0-9' | head -c "$1"; }  # sûr dans une URL PostgreSQL
admin_pw() { local p; while :; do p="$(alnum 20)"; [[ "$p" =~ [A-Za-z] && "$p" =~ [0-9] ]] && { echo "$p"; return; }; done; }

umask 077
cat > .env <<ENV
# Généré le $(date -u +%Y-%m-%dT%H:%M:%SZ) — NE JAMAIS versionner ni partager ce fichier.
DOMAIN=${DOMAIN}
ACME_EMAIL=${ACME_EMAIL}

# PostgreSQL : un mot de passe par rôle
DB_ADMIN_PASSWORD=$(alnum 32)
OWNER_DB_PASSWORD=$(alnum 32)
APP_DB_PASSWORD=$(alnum 32)
BACKUP_DB_PASSWORD=$(alnum 32)

# Clés applicatives (à conserver aussi hors du serveur : sans elles, données médicales illisibles / audit invérifiable)
DATA_ENCRYPTION_KEY=$(key32)
AUDIT_HMAC_KEY=$(key32)

# Compte propriétaire initial (changement imposé à la première connexion)
ADMIN_USERNAME=admin
ADMIN_PASSWORD=$(admin_pw)

# Sauvegardes hors serveur (identifiants du stockage : secrets/rclone.env)
BACKUP_TARGET=${BACKUP_TARGET}
BACKUP_KEEP_DAYS=30
BACKUP_HOUR=2
ENV
chmod 600 .env
mkdir -p secrets && chmod 700 secrets

echo "✔ .env créé (droits 600) pour ${DOMAIN}. Aucun secret n'a été affiché."
echo "  • Mot de passe initial du propriétaire : à lire UNE fois avec  grep '^ADMIN_PASSWORD=' .env"
echo "  • Sauvegardez hors serveur : DATA_ENCRYPTION_KEY, AUDIT_HMAC_KEY (coffre / support hors ligne)."
echo "  • Étape suivante : clé publique de sauvegarde et secrets/rclone.env (voir docs/DEPLOIEMENT.md)."
