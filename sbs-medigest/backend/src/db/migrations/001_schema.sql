-- =====================================================================
-- Plateforme SBS — schéma initial
-- Toutes les montants sont en GNF (entiers, pas de décimales).
-- Les données financières ne sont jamais supprimées physiquement :
-- elles sont annulées / archivées et tracées dans audit_log.
-- =====================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------------
-- Multi-site (prévu dès la conception, un seul site au départ)
-- ---------------------------------------------------------------------
CREATE TABLE sites (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL,
  address     TEXT,
  phone       TEXT,
  active      BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------
-- Paramètres & numérotation
-- ---------------------------------------------------------------------
CREATE TABLE settings (
  key         TEXT PRIMARY KEY,
  value       JSONB NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by  INTEGER
);

CREATE TABLE counters (
  key    TEXT NOT NULL,
  year   INTEGER NOT NULL,
  value  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (key, year)
);

-- ---------------------------------------------------------------------
-- Utilisateurs, rôles, permissions
-- ---------------------------------------------------------------------
CREATE TABLE permissions (
  code        TEXT PRIMARY KEY,
  module      TEXT NOT NULL,
  label       TEXT NOT NULL,
  sort_order  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE roles (
  id            SERIAL PRIMARY KEY,
  code          TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  description   TEXT,
  is_system     BOOLEAN NOT NULL DEFAULT FALSE,
  is_superadmin BOOLEAN NOT NULL DEFAULT FALSE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE role_permissions (
  role_id          INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_code  TEXT NOT NULL REFERENCES permissions(code) ON DELETE CASCADE,
  PRIMARY KEY (role_id, permission_code)
);

CREATE TABLE users (
  id                    SERIAL PRIMARY KEY,
  site_id               INTEGER REFERENCES sites(id),
  employee_number       TEXT NOT NULL UNIQUE,
  first_name            TEXT NOT NULL,
  last_name             TEXT NOT NULL,
  phone                 TEXT,
  email                 TEXT,
  job_title             TEXT,
  role_id               INTEGER NOT NULL REFERENCES roles(id),
  username              TEXT NOT NULL,
  password_hash         TEXT NOT NULL,
  must_change_password  BOOLEAN NOT NULL DEFAULT TRUE,
  status                TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  failed_attempts       INTEGER NOT NULL DEFAULT 0,
  locked_until          TIMESTAMPTZ,
  last_login_at         TIMESTAMPTZ,
  created_by            INTEGER REFERENCES users(id),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_username_uq ON users (lower(username));

-- Surcharges individuelles : accorder (granted=true) ou retirer (false) une permission du rôle
CREATE TABLE user_permissions (
  user_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  permission_code  TEXT NOT NULL REFERENCES permissions(code) ON DELETE CASCADE,
  granted          BOOLEAN NOT NULL,
  PRIMARY KEY (user_id, permission_code)
);

CREATE TABLE sessions (
  id           TEXT PRIMARY KEY,              -- sha256 du jeton (le jeton brut n'est jamais stocké)
  user_id      INTEGER NOT NULL REFERENCES users(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at   TIMESTAMPTZ NOT NULL,
  revoked_at   TIMESTAMPTZ,
  ip           TEXT,
  user_agent   TEXT
);
CREATE INDEX sessions_user_idx ON sessions (user_id);

CREATE TABLE login_events (
  id          BIGSERIAL PRIMARY KEY,
  user_id     INTEGER REFERENCES users(id),
  username    TEXT NOT NULL,
  event       TEXT NOT NULL CHECK (event IN ('login','logout','failed','locked','disabled')),
  ip          TEXT,
  user_agent  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX login_events_user_idx ON login_events (user_id, created_at DESC);
CREATE INDEX login_events_username_idx ON login_events (lower(username), created_at DESC);

-- ---------------------------------------------------------------------
-- Patients
-- ---------------------------------------------------------------------
CREATE TABLE patients (
  id                 SERIAL PRIMARY KEY,
  site_id            INTEGER REFERENCES sites(id),
  patient_number     TEXT NOT NULL UNIQUE,
  first_name         TEXT NOT NULL,
  last_name          TEXT NOT NULL,
  sex                TEXT CHECK (sex IN ('M','F')),
  birth_date         DATE,
  phone              TEXT,
  address            TEXT,
  emergency_contact  TEXT,
  -- champs médicaux sensibles, chiffrés côté application (AES-256-GCM)
  medical_history    TEXT,
  allergies          TEXT,
  blood_group        TEXT,
  notes              TEXT,
  created_by         INTEGER REFERENCES users(id),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  archived_at        TIMESTAMPTZ
);
CREATE INDEX patients_name_idx ON patients (lower(last_name), lower(first_name));
CREATE INDEX patients_phone_idx ON patients (phone);

-- ---------------------------------------------------------------------
-- Actes médicaux (catalogue)
-- ---------------------------------------------------------------------
CREATE TABLE medical_acts (
  id                SERIAL PRIMARY KEY,
  code              TEXT UNIQUE,
  name              TEXT NOT NULL,
  category          TEXT NOT NULL DEFAULT 'soin',
  description       TEXT,
  price             BIGINT NOT NULL CHECK (price >= 0),
  duration_minutes  INTEGER,
  active            BOOLEAN NOT NULL DEFAULT TRUE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------
-- Consultations
-- ---------------------------------------------------------------------
CREATE TABLE consultations (
  id               SERIAL PRIMARY KEY,
  site_id          INTEGER REFERENCES sites(id),
  number           TEXT NOT NULL UNIQUE,
  patient_id       INTEGER NOT NULL REFERENCES patients(id),
  doctor_id        INTEGER REFERENCES users(id),
  consulted_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  reason           TEXT,
  weight_kg        NUMERIC(5,1),
  temperature_c    NUMERIC(4,1),
  bp_systolic      INTEGER,
  bp_diastolic     INTEGER,
  heart_rate       INTEGER,
  spo2             INTEGER,
  observations     TEXT,   -- chiffré
  diagnosis        TEXT,   -- chiffré
  treatment        TEXT,   -- chiffré
  status           TEXT NOT NULL DEFAULT 'en_attente'
                   CHECK (status IN ('en_attente','en_cours','terminee','annulee')),
  amount           BIGINT NOT NULL DEFAULT 0,
  paid_amount      BIGINT NOT NULL DEFAULT 0,
  payment_status   TEXT NOT NULL DEFAULT 'non_payee'
                   CHECK (payment_status IN ('non_payee','partielle','payee')),
  cancel_reason    TEXT,
  created_by       INTEGER REFERENCES users(id),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX consultations_patient_idx ON consultations (patient_id, consulted_at DESC);
CREATE INDEX consultations_date_idx ON consultations (consulted_at);

-- Actes réalisés (facturés) — rattachés à une consultation
CREATE TABLE consultation_acts (
  id               SERIAL PRIMARY KEY,
  consultation_id  INTEGER NOT NULL REFERENCES consultations(id),
  act_id           INTEGER NOT NULL REFERENCES medical_acts(id),
  quantity         INTEGER NOT NULL DEFAULT 1 CHECK (quantity > 0),
  unit_price       BIGINT NOT NULL,
  performed_by     INTEGER REFERENCES users(id),
  performed_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  notes            TEXT
);

-- ---------------------------------------------------------------------
-- Fournisseurs, pharmacie, stock
-- ---------------------------------------------------------------------
CREATE TABLE suppliers (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL,
  phone       TEXT,
  email       TEXT,
  address     TEXT,
  products    TEXT,
  notes       TEXT,
  active      BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE products (
  id              SERIAL PRIMARY KEY,
  site_id         INTEGER REFERENCES sites(id),
  reference       TEXT NOT NULL UNIQUE,
  name            TEXT NOT NULL,
  category        TEXT NOT NULL DEFAULT 'medicament'
                  CHECK (category IN ('medicament','consommable','produit_medical')),
  form            TEXT,
  supplier_id     INTEGER REFERENCES suppliers(id),
  purchase_price  BIGINT NOT NULL DEFAULT 0,
  sale_price      BIGINT NOT NULL DEFAULT 0,
  quantity        INTEGER NOT NULL DEFAULT 0 CHECK (quantity >= 0),
  min_threshold   INTEGER NOT NULL DEFAULT 0,
  active          BOOLEAN NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX products_name_idx ON products (lower(name));

CREATE TABLE product_lots (
  id           SERIAL PRIMARY KEY,
  product_id   INTEGER NOT NULL REFERENCES products(id),
  lot_number   TEXT NOT NULL,
  expiry_date  DATE,
  quantity     INTEGER NOT NULL DEFAULT 0 CHECK (quantity >= 0),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (product_id, lot_number)
);

CREATE TABLE stock_movements (
  id           BIGSERIAL PRIMARY KEY,
  product_id   INTEGER NOT NULL REFERENCES products(id),
  lot_id       INTEGER REFERENCES product_lots(id),
  direction    TEXT NOT NULL CHECK (direction IN ('in','out','adjust')),
  reason       TEXT NOT NULL CHECK (reason IN
                 ('achat','livraison','retour','vente','utilisation','perte','expiration','inventaire','annulation_vente')),
  quantity     INTEGER NOT NULL,          -- variation signée
  qty_before   INTEGER NOT NULL,
  qty_after    INTEGER NOT NULL,
  unit_cost    BIGINT,
  supplier_id  INTEGER REFERENCES suppliers(id),
  document_ref TEXT,                      -- n° facture / bon de livraison
  ref_type     TEXT,
  ref_id       INTEGER,
  note         TEXT,
  created_by   INTEGER REFERENCES users(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX stock_movements_product_idx ON stock_movements (product_id, created_at DESC);
CREATE INDEX stock_movements_date_idx ON stock_movements (created_at);

CREATE TABLE pharmacy_sales (
  id              SERIAL PRIMARY KEY,
  site_id         INTEGER REFERENCES sites(id),
  number          TEXT NOT NULL UNIQUE,
  patient_id      INTEGER REFERENCES patients(id),
  customer_name   TEXT,
  prescription_id INTEGER,
  amount          BIGINT NOT NULL,
  paid_amount     BIGINT NOT NULL DEFAULT 0,
  payment_status  TEXT NOT NULL DEFAULT 'non_payee'
                  CHECK (payment_status IN ('non_payee','partielle','payee')),
  status          TEXT NOT NULL DEFAULT 'valide' CHECK (status IN ('valide','annulee')),
  cancel_reason   TEXT,
  sold_by         INTEGER REFERENCES users(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE pharmacy_sale_items (
  id          SERIAL PRIMARY KEY,
  sale_id     INTEGER NOT NULL REFERENCES pharmacy_sales(id),
  product_id  INTEGER NOT NULL REFERENCES products(id),
  quantity    INTEGER NOT NULL CHECK (quantity > 0),
  unit_price  BIGINT NOT NULL
);

CREATE TABLE inventories (
  id            SERIAL PRIMARY KEY,
  number        TEXT NOT NULL UNIQUE,
  status        TEXT NOT NULL DEFAULT 'en_cours' CHECK (status IN ('en_cours','valide','annule')),
  notes         TEXT,
  started_by    INTEGER REFERENCES users(id),
  started_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  validated_by  INTEGER REFERENCES users(id),
  validated_at  TIMESTAMPTZ
);

CREATE TABLE inventory_lines (
  id                SERIAL PRIMARY KEY,
  inventory_id      INTEGER NOT NULL REFERENCES inventories(id),
  product_id        INTEGER NOT NULL REFERENCES products(id),
  theoretical_qty   INTEGER NOT NULL,
  counted_qty       INTEGER,
  justification     TEXT,
  UNIQUE (inventory_id, product_id)
);

-- ---------------------------------------------------------------------
-- Prescriptions
-- ---------------------------------------------------------------------
CREATE TABLE prescriptions (
  id               SERIAL PRIMARY KEY,
  consultation_id  INTEGER REFERENCES consultations(id),
  patient_id       INTEGER NOT NULL REFERENCES patients(id),
  prescribed_by    INTEGER REFERENCES users(id),
  notes            TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE prescription_items (
  id               SERIAL PRIMARY KEY,
  prescription_id  INTEGER NOT NULL REFERENCES prescriptions(id) ON DELETE CASCADE,
  product_id       INTEGER REFERENCES products(id),
  drug_name        TEXT NOT NULL,
  dosage           TEXT,
  frequency        TEXT,
  duration         TEXT,
  quantity         INTEGER,
  instructions     TEXT
);

-- ---------------------------------------------------------------------
-- Laboratoire
-- ---------------------------------------------------------------------
CREATE TABLE lab_exam_types (
  id               SERIAL PRIMARY KEY,
  code             TEXT UNIQUE,
  name             TEXT NOT NULL,
  category         TEXT,
  price            BIGINT NOT NULL DEFAULT 0,
  unit             TEXT,
  reference_range  TEXT,
  active           BOOLEAN NOT NULL DEFAULT TRUE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE lab_requests (
  id               SERIAL PRIMARY KEY,
  site_id          INTEGER REFERENCES sites(id),
  number           TEXT NOT NULL UNIQUE,
  patient_id       INTEGER NOT NULL REFERENCES patients(id),
  consultation_id  INTEGER REFERENCES consultations(id),
  requested_by     INTEGER REFERENCES users(id),
  priority         TEXT NOT NULL DEFAULT 'normale' CHECK (priority IN ('normale','urgente')),
  status           TEXT NOT NULL DEFAULT 'demandee'
                   CHECK (status IN ('demandee','en_cours','terminee','annulee')),
  notes            TEXT,
  amount           BIGINT NOT NULL DEFAULT 0,
  paid_amount      BIGINT NOT NULL DEFAULT 0,
  payment_status   TEXT NOT NULL DEFAULT 'non_payee'
                   CHECK (payment_status IN ('non_payee','partielle','payee')),
  cancel_reason    TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at     TIMESTAMPTZ
);
CREATE INDEX lab_requests_status_idx ON lab_requests (status, created_at);

CREATE TABLE lab_request_items (
  id               SERIAL PRIMARY KEY,
  request_id       INTEGER NOT NULL REFERENCES lab_requests(id),
  exam_type_id     INTEGER NOT NULL REFERENCES lab_exam_types(id),
  price            BIGINT NOT NULL,
  result_value     TEXT,
  result_text      TEXT,
  unit             TEXT,
  reference_range  TEXT,
  abnormal         BOOLEAN,
  technician_id    INTEGER REFERENCES users(id),
  result_at        TIMESTAMPTZ
);

-- ---------------------------------------------------------------------
-- Rendez-vous
-- ---------------------------------------------------------------------
CREATE TABLE appointments (
  id                SERIAL PRIMARY KEY,
  site_id           INTEGER REFERENCES sites(id),
  patient_id        INTEGER NOT NULL REFERENCES patients(id),
  doctor_id         INTEGER REFERENCES users(id),
  scheduled_at      TIMESTAMPTZ NOT NULL,
  duration_minutes  INTEGER NOT NULL DEFAULT 20,
  reason            TEXT,
  status            TEXT NOT NULL DEFAULT 'planifie'
                    CHECK (status IN ('planifie','confirme','honore','annule','absent')),
  notes             TEXT,
  reminder_at       TIMESTAMPTZ,
  reminder_sent_at  TIMESTAMPTZ,
  cancel_reason     TEXT,
  created_by        INTEGER REFERENCES users(id),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX appointments_date_idx ON appointments (scheduled_at);

-- ---------------------------------------------------------------------
-- Caisse & paiements
-- ---------------------------------------------------------------------
CREATE TABLE cash_registers (
  id       SERIAL PRIMARY KEY,
  site_id  INTEGER REFERENCES sites(id),
  name     TEXT NOT NULL,
  active   BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE cash_sessions (
  id                SERIAL PRIMARY KEY,
  register_id       INTEGER NOT NULL REFERENCES cash_registers(id),
  number            TEXT NOT NULL UNIQUE,
  status            TEXT NOT NULL DEFAULT 'ouverte' CHECK (status IN ('ouverte','cloturee')),
  opening_balance   BIGINT NOT NULL CHECK (opening_balance >= 0),
  opened_by         INTEGER NOT NULL REFERENCES users(id),
  opened_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  expected_balance  BIGINT,
  declared_balance  BIGINT,
  discrepancy       BIGINT,
  justification     TEXT,
  closed_by         INTEGER REFERENCES users(id),
  closed_at         TIMESTAMPTZ
);
-- une seule session ouverte par caisse
CREATE UNIQUE INDEX cash_sessions_one_open ON cash_sessions (register_id) WHERE status = 'ouverte';

CREATE TABLE payments (
  id               SERIAL PRIMARY KEY,
  site_id          INTEGER REFERENCES sites(id),
  number           TEXT NOT NULL UNIQUE,     -- n° de transaction
  receipt_number   TEXT NOT NULL UNIQUE,
  patient_id       INTEGER REFERENCES patients(id),
  payer_name       TEXT,
  source_type      TEXT NOT NULL CHECK (source_type IN ('consultation','lab_request','pharmacy_sale','act','other')),
  source_id        INTEGER,
  description      TEXT NOT NULL,
  gross_amount     BIGINT NOT NULL CHECK (gross_amount >= 0),
  discount         BIGINT NOT NULL DEFAULT 0 CHECK (discount >= 0),
  amount           BIGINT NOT NULL CHECK (amount >= 0),   -- net encaissé
  method           TEXT NOT NULL CHECK (method IN ('especes','orange_money','mtn_money','virement','autre')),
  reference        TEXT,
  status           TEXT NOT NULL DEFAULT 'valide' CHECK (status IN ('valide','annule','rembourse')),
  cash_session_id  INTEGER REFERENCES cash_sessions(id),
  received_by      INTEGER NOT NULL REFERENCES users(id),
  idempotency_key  TEXT UNIQUE,
  cancel_reason    TEXT,
  cancelled_by     INTEGER REFERENCES users(id),
  cancelled_at     TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX payments_date_idx ON payments (created_at);
CREATE INDEX payments_patient_idx ON payments (patient_id);
CREATE INDEX payments_source_idx ON payments (source_type, source_id);

-- Grand livre de la caisse physique (espèces uniquement)
CREATE TABLE cash_movements (
  id               BIGSERIAL PRIMARY KEY,
  cash_session_id  INTEGER NOT NULL REFERENCES cash_sessions(id),
  direction        TEXT NOT NULL CHECK (direction IN ('in','out')),
  category         TEXT NOT NULL CHECK (category IN ('paiement','depense','remboursement','annulation','correction')),
  amount           BIGINT NOT NULL CHECK (amount > 0),
  ref_type         TEXT,
  ref_id           INTEGER,
  note             TEXT,
  created_by       INTEGER NOT NULL REFERENCES users(id),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX cash_movements_session_idx ON cash_movements (cash_session_id);

-- ---------------------------------------------------------------------
-- Dépenses
-- ---------------------------------------------------------------------
CREATE TABLE expenses (
  id                   SERIAL PRIMARY KEY,
  site_id              INTEGER REFERENCES sites(id),
  number               TEXT NOT NULL UNIQUE,
  category             TEXT NOT NULL,
  amount               BIGINT NOT NULL CHECK (amount > 0),
  reason               TEXT NOT NULL,
  beneficiary          TEXT,
  supplier_id          INTEGER REFERENCES suppliers(id),
  expense_date         DATE NOT NULL DEFAULT CURRENT_DATE,
  attachment_path      TEXT,
  attachment_name      TEXT,
  status               TEXT NOT NULL DEFAULT 'en_attente'
                       CHECK (status IN ('en_attente','validee','refusee','annulee')),
  requires_validation  BOOLEAN NOT NULL DEFAULT FALSE,
  validated_by         INTEGER REFERENCES users(id),
  validated_at         TIMESTAMPTZ,
  validation_comment   TEXT,
  pay_from_cash        BOOLEAN NOT NULL DEFAULT FALSE,
  disbursed            BOOLEAN NOT NULL DEFAULT FALSE,
  disbursed_by         INTEGER REFERENCES users(id),
  disbursed_at         TIMESTAMPTZ,
  cash_session_id      INTEGER REFERENCES cash_sessions(id),
  created_by           INTEGER NOT NULL REFERENCES users(id),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX expenses_date_idx ON expenses (expense_date);

-- ---------------------------------------------------------------------
-- Notifications & alertes
-- ---------------------------------------------------------------------
CREATE TABLE notifications (
  id          BIGSERIAL PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id),
  type        TEXT NOT NULL,
  icon        TEXT,
  title       TEXT NOT NULL,
  body        TEXT,
  link        TEXT,
  read_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX notifications_user_idx ON notifications (user_id, created_at DESC);

CREATE TABLE alerts (
  id               BIGSERIAL PRIMARY KEY,
  category         TEXT NOT NULL CHECK (category IN ('financiere','stock','systeme')),
  type             TEXT NOT NULL,
  severity         TEXT NOT NULL CHECK (severity IN ('haute','moyenne')),
  title            TEXT NOT NULL,
  details          JSONB,
  ref_type         TEXT,
  ref_id           INTEGER,
  user_id          INTEGER REFERENCES users(id),  -- employé concerné (le cas échéant)
  dedupe_key       TEXT,
  status           TEXT NOT NULL DEFAULT 'nouvelle'
                   CHECK (status IN ('nouvelle','en_verification','resolue','ignoree')),
  resolved_by      INTEGER REFERENCES users(id),
  resolved_at      TIMESTAMPTZ,
  resolution_note  TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX alerts_open_dedupe ON alerts (dedupe_key)
  WHERE dedupe_key IS NOT NULL AND status IN ('nouvelle','en_verification');
CREATE INDEX alerts_status_idx ON alerts (status, created_at DESC);

-- ---------------------------------------------------------------------
-- Journal d'audit — append-only, chaîné par hachage
-- ---------------------------------------------------------------------
CREATE SEQUENCE audit_log_id_seq;
CREATE TABLE audit_log (
  id           BIGINT PRIMARY KEY,         -- attribué par le trigger (ordre = ordre de la chaîne)
  user_id      INTEGER REFERENCES users(id),
  username     TEXT,
  action       TEXT NOT NULL,
  entity_type  TEXT,
  entity_id    TEXT,
  summary      TEXT,
  old_value    JSONB,
  new_value    JSONB,
  reason       TEXT,
  ip           TEXT,
  user_agent   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  prev_hash    TEXT,
  hash         TEXT
);
CREATE INDEX audit_log_date_idx ON audit_log (created_at DESC);
CREATE INDEX audit_log_user_idx ON audit_log (user_id, created_at DESC);
CREATE INDEX audit_log_entity_idx ON audit_log (entity_type, entity_id);

CREATE FUNCTION audit_row_hash(r audit_log) RETURNS TEXT
LANGUAGE sql IMMUTABLE AS $$
  SELECT encode(digest(
    coalesce(r.prev_hash,'') || '|' || r.id || '|' || coalesce(r.user_id::text,'') || '|' ||
    coalesce(r.username,'') || '|' || r.action || '|' || coalesce(r.entity_type,'') || '|' ||
    coalesce(r.entity_id,'') || '|' || coalesce(r.summary,'') || '|' ||
    coalesce(r.old_value::text,'') || '|' || coalesce(r.new_value::text,'') || '|' ||
    coalesce(r.reason,'') || '|' || to_char(r.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US'),
    'sha256'), 'hex')
$$;

CREATE FUNCTION audit_log_before_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- Sérialise les insertions pour garantir une chaîne linéaire
  PERFORM pg_advisory_xact_lock(424242);
  NEW.id := nextval('audit_log_id_seq');
  SELECT hash INTO NEW.prev_hash FROM audit_log ORDER BY id DESC LIMIT 1;
  NEW.hash := audit_row_hash(NEW);
  RETURN NEW;
END $$;

CREATE TRIGGER audit_log_chain BEFORE INSERT ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_before_insert();

CREATE FUNCTION audit_log_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_log est en ajout seul : modification ou suppression interdite';
END $$;

CREATE TRIGGER audit_log_no_update BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_immutable();
CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION audit_log_immutable();

-- Protection des paiements : aucune suppression physique
CREATE FUNCTION forbid_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Suppression physique interdite sur % (utiliser une annulation tracée)', TG_TABLE_NAME;
END $$;

CREATE TRIGGER payments_no_delete BEFORE DELETE ON payments FOR EACH ROW EXECUTE FUNCTION forbid_delete();
CREATE TRIGGER cash_sessions_no_delete BEFORE DELETE ON cash_sessions FOR EACH ROW EXECUTE FUNCTION forbid_delete();
CREATE TRIGGER cash_movements_no_delete BEFORE DELETE ON cash_movements FOR EACH ROW EXECUTE FUNCTION forbid_delete();
CREATE TRIGGER expenses_no_delete BEFORE DELETE ON expenses FOR EACH ROW EXECUTE FUNCTION forbid_delete();
CREATE TRIGGER stock_movements_no_delete BEFORE DELETE ON stock_movements FOR EACH ROW EXECUTE FUNCTION forbid_delete();
