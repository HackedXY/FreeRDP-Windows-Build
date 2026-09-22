#!/bin/sh
# Sauvegarde chiffrée de la base + justificatifs, avec rotation.
# Variables : PGHOST PGUSER PGPASSWORD PGDATABASE BACKUP_PASSPHRASE BACKUP_KEEP_DAYS
# Copie hors serveur : synchroniser /backups vers un stockage distant (rclone, rsync…),
# par ex. via une tâche cron de l'hôte : rclone sync ./backups remote:sbs-backups
set -eu
DIR=/backups
TS=$(date +%Y%m%d-%H%M%S)
mkdir -p "$DIR"
pg_dump -Fc --no-owner | openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt -pass env:BACKUP_PASSPHRASE -out "$DIR/sbs-db-$TS.dump.enc"
if [ -d /uploads ]; then
  tar -C /uploads -czf - . | openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt -pass env:BACKUP_PASSPHRASE -out "$DIR/sbs-uploads-$TS.tar.gz.enc"
fi
find "$DIR" -name 'sbs-*.enc' -mtime +"${BACKUP_KEEP_DAYS:-30}" -delete
echo "[$(date)] sauvegarde OK : sbs-db-$TS.dump.enc"
