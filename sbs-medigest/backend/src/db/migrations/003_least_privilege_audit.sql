-- =====================================================================
-- Intégrité du journal d'audit & moindre privilège
--
-- Rôles PostgreSQL (créés au provisionnement, cf. deploy/db-init) :
--   * propriétaire du schéma  : migrations uniquement (jamais dans le conteneur applicatif)
--   * sbs_app                 : exécution de l'application
--   * sbs_backup              : sauvegardes (lecture seule + état des sauvegardes)
--
-- sbs_app n'est pas propriétaire des tables : il ne peut ni désactiver les
-- triggers, ni modifier/supprimer/vider le journal d'audit (INSERT/SELECT seuls).
-- Chaque entrée est en outre signée (HMAC-SHA256) par l'application avec une
-- clé conservée hors de la base : une réécriture faite avec des identifiants
-- propriétaire (chaîne recalculée comprise) reste détectable sans cette clé.
-- =====================================================================

CREATE TABLE audit_signatures (
  audit_id    BIGINT PRIMARY KEY REFERENCES audit_log(id),
  key_id      TEXT NOT NULL,
  sig         TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TRIGGER audit_signatures_no_update BEFORE UPDATE OR DELETE ON audit_signatures
  FOR EACH ROW EXECUTE FUNCTION audit_log_immutable();
CREATE TRIGGER audit_signatures_no_truncate BEFORE TRUNCATE ON audit_signatures
  FOR EACH STATEMENT EXECUTE FUNCTION audit_log_immutable();

-- Droits applicatifs (idempotent ; rappelé après chaque migration et après restauration)
CREATE OR REPLACE FUNCTION sbs_apply_grants() RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  append_only TEXT[] := ARRAY['audit_log', 'audit_signatures', 'login_events'];
  no_delete   TEXT[] := ARRAY['payments', 'cash_movements', 'cash_sessions', 'expenses', 'stock_movements'];
  read_only   TEXT[] := ARRAY['schema_migrations', 'permissions'];
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
    EXECUTE 'GRANT USAGE ON SCHEMA public TO sbs_backup';
    EXECUTE 'GRANT SELECT ON ALL TABLES IN SCHEMA public TO sbs_backup';
    EXECUTE 'GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO sbs_backup';
    IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'backup_runs') THEN
      EXECUTE 'GRANT INSERT, UPDATE ON backup_runs TO sbs_backup';
    END IF;
  END IF;
END $$;
