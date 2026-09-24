-- Journal des sauvegardes (écrit par le rôle sbs_backup, lu par l'application
-- qui alerte en cas d'échec ou d'absence de sauvegarde récente).
CREATE TABLE backup_runs (
  id              SERIAL PRIMARY KEY,
  started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at     TIMESTAMPTZ,
  status          TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running','success','failed')),
  set_name        TEXT,
  target_kind     TEXT,
  db_bytes        BIGINT,
  uploads_count   INTEGER,
  uploads_bytes   BIGINT,
  manifest_sha256 TEXT,
  audit_head_id   BIGINT,
  audit_head_hash TEXT,
  error           TEXT,
  host            TEXT
);
CREATE INDEX backup_runs_started_idx ON backup_runs (started_at DESC);

-- Restauration : les lignes d'audit restaurées conservent leur identifiant et
-- leur hachage d'origine. Ce contournement n'est possible qu'en contexte
-- « system », réservé au rôle propriétaire du schéma (jamais l'application).
CREATE OR REPLACE FUNCTION audit_log_before_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF sbs_is_system() AND NEW.hash IS NOT NULL AND NEW.id IS NOT NULL THEN
    RETURN NEW;
  END IF;
  PERFORM pg_advisory_xact_lock(424242);
  NEW.id := nextval('audit_log_id_seq');
  SELECT hash INTO NEW.prev_hash FROM audit_log ORDER BY id DESC LIMIT 1;
  NEW.hash := audit_row_hash(NEW);
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION sbs_apply_grants() RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  append_only TEXT[] := ARRAY['audit_log', 'audit_signatures', 'login_events'];
  no_delete   TEXT[] := ARRAY['payments', 'cash_movements', 'cash_sessions', 'expenses', 'stock_movements'];
  read_only   TEXT[] := ARRAY['schema_migrations', 'permissions', 'backup_runs'];
  t TEXT;
BEGIN
  EXECUTE 'REVOKE CREATE ON SCHEMA public FROM PUBLIC';
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sbs_app') THEN
    EXECUTE 'REVOKE ALL ON ALL TABLES IN SCHEMA public FROM sbs_app';
    EXECUTE 'REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM sbs_app';
    EXECUTE 'GRANT USAGE ON SCHEMA public TO sbs_app';
    FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
      IF t = ANY(append_only) THEN
        EXECUTE format('GRANT SELECT, INSERT ON %I TO sbs_app', t);
      ELSIF t = ANY(no_delete) THEN
        EXECUTE format('GRANT SELECT, INSERT, UPDATE ON %I TO sbs_app', t);
      ELSIF t = ANY(read_only) THEN
        EXECUTE format('GRANT SELECT ON %I TO sbs_app', t);
      ELSE
        EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO sbs_app', t);
      END IF;
    END LOOP;
    EXECUTE 'GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO sbs_app';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sbs_backup') THEN
    EXECUTE 'REVOKE ALL ON ALL TABLES IN SCHEMA public FROM sbs_backup';
    EXECUTE 'REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM sbs_backup';
    EXECUTE 'GRANT USAGE ON SCHEMA public TO sbs_backup';
    EXECUTE 'GRANT SELECT ON ALL TABLES IN SCHEMA public TO sbs_backup';
    EXECUTE 'GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO sbs_backup';
    EXECUTE 'GRANT INSERT, UPDATE ON backup_runs TO sbs_backup';
    EXECUTE 'GRANT USAGE ON SEQUENCE backup_runs_id_seq TO sbs_backup';
  END IF;
END $$;

-- search_path figé pour toutes les fonctions (durcissement ; indispensable aussi à la
-- restauration, pg_dump vidant search_path pendant le chargement des données).
ALTER FUNCTION audit_row_hash(audit_log) SET search_path = public, pg_catalog;
ALTER FUNCTION audit_log_before_insert() SET search_path = public, pg_catalog;
ALTER FUNCTION audit_log_immutable() SET search_path = public, pg_catalog;
ALTER FUNCTION forbid_delete() SET search_path = public, pg_catalog;
ALTER FUNCTION sbs_actor() SET search_path = public, pg_catalog;
ALTER FUNCTION sbs_is_system() SET search_path = public, pg_catalog;
ALTER FUNCTION sbs_actor_is_superadmin() SET search_path = public, pg_catalog;
ALTER FUNCTION sbs_role_is_privileged(integer) SET search_path = public, pg_catalog;
ALTER FUNCTION sbs_user_is_privileged(integer) SET search_path = public, pg_catalog;
ALTER FUNCTION sbs_privileged_allowed() SET search_path = public, pg_catalog;
ALTER FUNCTION sbs_guard_owner_only() SET search_path = public, pg_catalog;
ALTER FUNCTION sbs_guard_users() SET search_path = public, pg_catalog;
ALTER FUNCTION sbs_apply_grants() SET search_path = public, pg_catalog;
