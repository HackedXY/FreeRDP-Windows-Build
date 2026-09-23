#!/bin/sh
# Exécuté une seule fois par l'image postgres lors de l'initialisation du volume.
# Crée trois rôles distincts (mots de passe fournis par l'environnement, jamais écrits ici) :
#   sbs         propriétaire du schéma — utilisé UNIQUEMENT par le service « migrate »
#   sbs_app     application — pas propriétaire : ne peut ni altérer le schéma ni réécrire l'audit
#   sbs_backup  sauvegardes — lecture seule (+ journal des sauvegardes)
set -eu
: "${OWNER_DB_PASSWORD:?}" "${APP_DB_PASSWORD:?}" "${BACKUP_DB_PASSWORD:?}"
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres \
  -v owner_pw="$OWNER_DB_PASSWORD" -v app_pw="$APP_DB_PASSWORD" -v backup_pw="$BACKUP_DB_PASSWORD" <<'SQL'
CREATE ROLE sbs LOGIN PASSWORD :'owner_pw' NOSUPERUSER NOCREATEDB NOCREATEROLE;
CREATE ROLE sbs_app LOGIN PASSWORD :'app_pw' NOSUPERUSER NOCREATEDB NOCREATEROLE;
CREATE ROLE sbs_backup LOGIN PASSWORD :'backup_pw' NOSUPERUSER NOCREATEDB NOCREATEROLE;
ALTER DATABASE sbs OWNER TO sbs;
REVOKE ALL ON DATABASE sbs FROM PUBLIC;
GRANT CONNECT ON DATABASE sbs TO sbs, sbs_app, sbs_backup;
SQL
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname sbs -c 'ALTER SCHEMA public OWNER TO sbs; REVOKE CREATE ON SCHEMA public FROM PUBLIC;'
