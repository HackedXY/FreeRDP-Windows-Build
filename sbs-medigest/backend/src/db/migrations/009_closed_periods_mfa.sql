-- =====================================================================
-- Phase 1 de remédiation
--  1. Clôture de caisse : une session clôturée, ses mouvements et les
--     paiements qui y sont rattachés deviennent immuables (défense en
--     profondeur en plus des contrôles applicatifs). Les verrous FOR SHARE
--     sérialisent annulation / encaissement et clôture concurrents.
--  2. Double authentification (TOTP) : secrets chiffrés côté application,
--     codes de récupération hachés, défis de connexion à usage unique.
--  3. Nouveaux évènements de connexion (échec 2FA, expiration d'inactivité).
-- Code d'erreur applicatif SB409 : conflit métier (renvoyé en HTTP 409).
-- =====================================================================

-- ---------------------------------------------------------------- Caisse
CREATE FUNCTION sbs_cash_session_open(p_session INTEGER) RETURNS BOOLEAN
LANGUAGE plpgsql AS $$
DECLARE st TEXT;
BEGIN
  -- FOR SHARE : attend la fin d'une clôture en cours puis relit l'état validé
  SELECT status INTO st FROM cash_sessions WHERE id = p_session FOR SHARE;
  RETURN st = 'ouverte';
END $$;

CREATE FUNCTION sbs_cash_movement_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'Mouvement de caisse immuable : enregistrez une correction.' USING ERRCODE = 'SB409';
  END IF;
  IF NOT sbs_cash_session_open(NEW.cash_session_id) THEN
    RAISE EXCEPTION 'Caisse clôturée : aucun mouvement ne peut y être ajouté.' USING ERRCODE = 'SB409';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER cash_movements_guard BEFORE INSERT OR UPDATE ON cash_movements
  FOR EACH ROW EXECUTE FUNCTION sbs_cash_movement_guard();

CREATE FUNCTION sbs_cash_session_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'cloturee' THEN
    RAISE EXCEPTION 'Session de caisse clôturée : modification interdite.' USING ERRCODE = 'SB409';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER cash_sessions_guard BEFORE UPDATE ON cash_sessions
  FOR EACH ROW EXECUTE FUNCTION sbs_cash_session_guard();

-- Paiements d'une caisse clôturée : seul le remboursement (tracé dans la caisse ouverte) reste possible
CREATE FUNCTION sbs_payment_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.cash_session_id IS NOT NULL AND NOT sbs_cash_session_open(NEW.cash_session_id) THEN
      RAISE EXCEPTION 'Caisse clôturée : impossible d''y rattacher un paiement.' USING ERRCODE = 'SB409';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.cash_session_id IS NOT NULL AND NOT sbs_cash_session_open(OLD.cash_session_id) THEN
    IF NEW.amount IS DISTINCT FROM OLD.amount OR NEW.gross_amount IS DISTINCT FROM OLD.gross_amount
       OR NEW.discount IS DISTINCT FROM OLD.discount OR NEW.method IS DISTINCT FROM OLD.method
       OR NEW.cash_session_id IS DISTINCT FROM OLD.cash_session_id OR NEW.created_at IS DISTINCT FROM OLD.created_at
       OR (NEW.status IS DISTINCT FROM OLD.status AND NEW.status <> 'rembourse') THEN
      RAISE EXCEPTION 'Paiement rattaché à une caisse clôturée : seul un remboursement est possible.' USING ERRCODE = 'SB409';
    END IF;
  ELSIF NEW.cash_session_id IS DISTINCT FROM OLD.cash_session_id AND NEW.cash_session_id IS NOT NULL
        AND NOT sbs_cash_session_open(NEW.cash_session_id) THEN
    RAISE EXCEPTION 'Caisse clôturée : impossible d''y rattacher un paiement.' USING ERRCODE = 'SB409';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER payments_guard BEFORE INSERT OR UPDATE ON payments
  FOR EACH ROW EXECUTE FUNCTION sbs_payment_guard();

-- Dépense décaissée : montant, statut et rattachement figés
CREATE FUNCTION sbs_expense_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.disbursed AND (NEW.amount IS DISTINCT FROM OLD.amount OR NEW.status IS DISTINCT FROM OLD.status
      OR NOT NEW.disbursed OR NEW.cash_session_id IS DISTINCT FROM OLD.cash_session_id) THEN
    RAISE EXCEPTION 'Dépense décaissée : modification interdite.' USING ERRCODE = 'SB409';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER expenses_guard BEFORE UPDATE ON expenses
  FOR EACH ROW EXECUTE FUNCTION sbs_expense_guard();

-- ---------------------------------------------------------------- 2FA (TOTP)
CREATE TABLE user_mfa (
  user_id             INTEGER PRIMARY KEY REFERENCES users(id),
  secret_enc          TEXT,          -- secret TOTP chiffré (AES-256-GCM), jamais en clair
  pending_secret_enc  TEXT,          -- secret en cours d'activation (non confirmé)
  pending_created_at  TIMESTAMPTZ,
  enabled_at          TIMESTAMPTZ,
  last_step           BIGINT,        -- dernier pas de temps accepté (anti-rejeu)
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE mfa_recovery_codes (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id),
  code_hash   TEXT NOT NULL,         -- HMAC-SHA256 du code (le code n'est jamais stocké)
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  used_at     TIMESTAMPTZ
);
CREATE INDEX mfa_recovery_codes_user_idx ON mfa_recovery_codes (user_id) WHERE used_at IS NULL;

-- Défi de connexion : délivré après le mot de passe, échangé contre une session avec un code valide
CREATE TABLE mfa_challenges (
  id           TEXT PRIMARY KEY,     -- sha256 du jeton (le jeton brut n'est jamais stocké)
  user_id      INTEGER NOT NULL REFERENCES users(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at   TIMESTAMPTZ NOT NULL,
  attempts     INTEGER NOT NULL DEFAULT 0,
  consumed_at  TIMESTAMPTZ,
  ip           TEXT
);

-- Seul l'utilisateur concerné (ou le contexte système) peut modifier sa 2FA
CREATE FUNCTION sbs_guard_mfa() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target INTEGER := CASE WHEN TG_OP = 'DELETE' THEN OLD.user_id ELSE NEW.user_id END;
BEGIN
  IF NOT sbs_is_system() AND sbs_actor() IS DISTINCT FROM target THEN
    RAISE EXCEPTION 'La double authentification ne peut être modifiée que par son titulaire' USING ERRCODE = '42501';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;
CREATE TRIGGER user_mfa_guard BEFORE INSERT OR UPDATE OR DELETE ON user_mfa
  FOR EACH ROW EXECUTE FUNCTION sbs_guard_mfa();
CREATE TRIGGER mfa_recovery_codes_guard BEFORE INSERT OR UPDATE OR DELETE ON mfa_recovery_codes
  FOR EACH ROW EXECUTE FUNCTION sbs_guard_mfa();

-- ---------------------------------------------------------------- Connexions
ALTER TABLE login_events DROP CONSTRAINT login_events_event_check;
ALTER TABLE login_events ADD CONSTRAINT login_events_event_check
  CHECK (event IN ('login','logout','failed','locked','disabled','mfa_failed','expired'));

ALTER FUNCTION sbs_cash_session_open(integer) SET search_path = public, pg_catalog;
ALTER FUNCTION sbs_cash_movement_guard() SET search_path = public, pg_catalog;
ALTER FUNCTION sbs_cash_session_guard() SET search_path = public, pg_catalog;
ALTER FUNCTION sbs_payment_guard() SET search_path = public, pg_catalog;
ALTER FUNCTION sbs_expense_guard() SET search_path = public, pg_catalog;
ALTER FUNCTION sbs_guard_mfa() SET search_path = public, pg_catalog;
