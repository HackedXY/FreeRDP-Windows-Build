-- =====================================================================
-- Phase 4 : contrôles de caisse
--  1. Solde jamais négatif : toute sortie d'espèces est refusée si elle dépasse
--     l'argent présent dans la caisse (verrou sur la session : sorties concurrentes sérialisées).
--  2. Report explicite d'une session à la suivante :
--       clôture  : montant laissé dans le tiroir (carry_over) et montant retiré
--                  (withdrawn, destination obligatoire : coffre, banque, propriétaire…)
--       ouverture: solde attendu = report de la dernière clôture de la même caisse ;
--                  tout écart exige une justification (et lève une alerte).
-- =====================================================================
ALTER TABLE cash_sessions
  ADD COLUMN carry_over BIGINT CHECK (carry_over >= 0),
  ADD COLUMN withdrawn BIGINT CHECK (withdrawn >= 0),
  ADD COLUMN withdrawal_note TEXT,
  ADD COLUMN carried_from_session_id INTEGER REFERENCES cash_sessions(id),
  ADD COLUMN expected_opening BIGINT,
  ADD COLUMN opening_justification TEXT,
  ADD CONSTRAINT cash_sessions_carry_consistent
    CHECK (carry_over IS NULL OR (declared_balance IS NOT NULL AND carry_over + coalesce(withdrawn, 0) = declared_balance));

CREATE OR REPLACE FUNCTION sbs_cash_movement_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  s RECORD;
  bal BIGINT;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'Mouvement de caisse immuable : enregistrez une correction.' USING ERRCODE = 'SB409';
  END IF;
  -- FOR UPDATE : attend une clôture en cours et sérialise les sorties d'une même caisse
  SELECT status, opening_balance INTO s FROM cash_sessions WHERE id = NEW.cash_session_id FOR UPDATE;
  IF s.status IS DISTINCT FROM 'ouverte' THEN
    RAISE EXCEPTION 'Caisse clôturée : aucun mouvement ne peut y être ajouté.' USING ERRCODE = 'SB409';
  END IF;
  IF NEW.direction = 'out' THEN
    SELECT s.opening_balance + coalesce(sum(CASE WHEN direction = 'in' THEN amount ELSE -amount END), 0)
      INTO bal FROM cash_movements WHERE cash_session_id = NEW.cash_session_id;
    IF bal - NEW.amount < 0 THEN
      RAISE EXCEPTION 'Solde de caisse insuffisant : % GNF disponibles, sortie de % GNF refusée.', bal, NEW.amount USING ERRCODE = 'SB409';
    END IF;
  END IF;
  RETURN NEW;
END $$;
ALTER FUNCTION sbs_cash_movement_guard() SET search_path = public, pg_catalog;

-- Marqueur « base de production » (posé par le service de migration) : non modifiable
-- ni supprimable par le rôle applicatif (garde-fou contre le jeu de démonstration).
CREATE FUNCTION sbs_guard_deployment_marker() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.key = 'deployment' AND NOT sbs_is_system() THEN
    RAISE EXCEPTION 'Le marqueur de déploiement ne peut pas être modifié' USING ERRCODE = '42501';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;
ALTER FUNCTION sbs_guard_deployment_marker() SET search_path = public, pg_catalog;
CREATE TRIGGER settings_deployment_guard BEFORE UPDATE OR DELETE ON settings
  FOR EACH ROW EXECUTE FUNCTION sbs_guard_deployment_marker();
