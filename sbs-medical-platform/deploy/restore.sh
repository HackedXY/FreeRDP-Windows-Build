#!/bin/sh
# Restauration : ./deploy/restore.sh backups/sbs-db-AAAAMMJJ-HHMMSS.dump.enc
# (à lancer sur l'hôte ; arrêter l'application avant : docker compose stop app)
set -eu
FILE=${1:?fichier de sauvegarde requis}
[ -n "${BACKUP_PASSPHRASE:-}" ] || { printf 'Phrase de chiffrement : '; stty -echo; read BACKUP_PASSPHRASE; stty echo; echo; export BACKUP_PASSPHRASE; }
openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass env:BACKUP_PASSPHRASE -in "$FILE" \
  | docker compose exec -T db pg_restore --clean --if-exists --no-owner -U sbs -d sbs
echo "Restauration terminée. Redémarrer : docker compose start app"
