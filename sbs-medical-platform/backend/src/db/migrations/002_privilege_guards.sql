-- =====================================================================
-- Garde-fous anti-escalade de privilèges (défense en profondeur).
-- L'application déclare l'utilisateur agissant dans chaque transaction
-- sensible : SELECT set_config('sbs.actor_id', '<id>', true).
-- Seul un super-administrateur actif (ou le contexte « system » réservé
-- au rôle propriétaire du schéma : migrations / initialisation) peut :
--   * créer / modifier / supprimer des rôles et leurs permissions ;
--   * accorder ou retirer des permissions individuelles ;
--   * attribuer un rôle privilégié, ou gérer un compte privilégié
--     (mot de passe, statut, identifiant, rôle).
-- Personne ne peut modifier son propre rôle.
-- =====================================================================

ALTER TABLE permissions ADD COLUMN high_privilege BOOLEAN NOT NULL DEFAULT FALSE;

CREATE FUNCTION sbs_actor() RETURNS INTEGER LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('sbs.actor_id', true), '')::int
$$;

-- Le contexte « system » n'est honoré que pour le rôle propriétaire du schéma
CREATE FUNCTION sbs_is_system() RETURNS BOOLEAN LANGUAGE sql STABLE AS $$
  SELECT coalesce(current_setting('sbs.context', true), '') = 'system'
     AND pg_has_role(current_user, (SELECT tableowner FROM pg_tables WHERE schemaname = 'public' AND tablename = 'users'), 'MEMBER')
$$;

CREATE FUNCTION sbs_actor_is_superadmin() RETURNS BOOLEAN LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM users u JOIN roles r ON r.id = u.role_id
                 WHERE u.id = sbs_actor() AND u.status = 'active' AND r.is_superadmin)
$$;

CREATE FUNCTION sbs_role_is_privileged(p_role INTEGER) RETURNS BOOLEAN LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM roles WHERE id = p_role AND is_superadmin)
      OR EXISTS (SELECT 1 FROM role_permissions rp JOIN permissions p ON p.code = rp.permission_code
                 WHERE rp.role_id = p_role AND p.high_privilege)
$$;

CREATE FUNCTION sbs_user_is_privileged(p_user INTEGER) RETURNS BOOLEAN LANGUAGE sql STABLE AS $$
  SELECT sbs_role_is_privileged((SELECT role_id FROM users WHERE id = p_user))
      OR EXISTS (SELECT 1 FROM user_permissions up JOIN permissions p ON p.code = up.permission_code
                 WHERE up.user_id = p_user AND up.granted AND p.high_privilege)
$$;

CREATE FUNCTION sbs_privileged_allowed() RETURNS BOOLEAN LANGUAGE sql STABLE AS $$
  SELECT sbs_is_system() OR sbs_actor_is_superadmin()
$$;

CREATE FUNCTION sbs_guard_owner_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT sbs_privileged_allowed() THEN
    RAISE EXCEPTION 'Opération réservée au propriétaire (super-administrateur) sur %', TG_TABLE_NAME
      USING ERRCODE = '42501';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;

CREATE TRIGGER roles_owner_only BEFORE INSERT OR UPDATE OR DELETE ON roles
  FOR EACH ROW EXECUTE FUNCTION sbs_guard_owner_only();
CREATE TRIGGER role_permissions_owner_only BEFORE INSERT OR UPDATE OR DELETE ON role_permissions
  FOR EACH ROW EXECUTE FUNCTION sbs_guard_owner_only();
CREATE TRIGGER user_permissions_owner_only BEFORE INSERT OR UPDATE OR DELETE ON user_permissions
  FOR EACH ROW EXECUTE FUNCTION sbs_guard_owner_only();

CREATE FUNCTION sbs_guard_users() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF sbs_privileged_allowed() AND NOT (TG_OP = 'UPDATE' AND NEW.role_id <> OLD.role_id AND NEW.id = sbs_actor()) THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF sbs_role_is_privileged(NEW.role_id) THEN
      RAISE EXCEPTION 'Seul le propriétaire peut créer un compte privilégié' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;
  -- UPDATE
  IF NEW.role_id <> OLD.role_id THEN
    IF NEW.id = sbs_actor() THEN
      RAISE EXCEPTION 'Impossible de modifier son propre rôle' USING ERRCODE = '42501';
    END IF;
    IF sbs_role_is_privileged(NEW.role_id) OR sbs_role_is_privileged(OLD.role_id) THEN
      RAISE EXCEPTION 'Seul le propriétaire peut attribuer ou retirer un rôle privilégié' USING ERRCODE = '42501';
    END IF;
  END IF;
  IF (NEW.password_hash IS DISTINCT FROM OLD.password_hash OR NEW.status IS DISTINCT FROM OLD.status
      OR NEW.username IS DISTINCT FROM OLD.username)
     AND NEW.id IS DISTINCT FROM sbs_actor()
     AND sbs_user_is_privileged(OLD.id) THEN
    RAISE EXCEPTION 'Seul le propriétaire peut gérer un compte privilégié' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER users_privilege_guard BEFORE INSERT OR UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION sbs_guard_users();
