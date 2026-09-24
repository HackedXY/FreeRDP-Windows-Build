-- =====================================================================
-- Phase 2 de remédiation : parcours médical
--  1. Prescriptions : numéro unique, statut de délivrance, délivrances
--     rattachées aux lignes (quantités délivrées, par qui, quand).
--  2. Factures : regroupement des éléments facturables d'un patient
--     (totaux, remises, payé, solde calculés depuis les paiements).
--  3. Certificats médicaux (contenu chiffré côté application).
--  4. Laboratoire : valeurs de référence numériques, validation des résultats.
--  5. Nouvelles permissions : certificats, validation biologique.
-- =====================================================================

-- ---------------------------------------------------------------- Prescriptions
ALTER TABLE prescriptions ADD COLUMN number TEXT;
ALTER TABLE prescriptions ADD COLUMN status TEXT NOT NULL DEFAULT 'en_attente'
  CHECK (status IN ('en_attente', 'partielle', 'delivree'));
UPDATE prescriptions SET number = 'ORD-' || to_char(created_at, 'YYYY') || '-' || lpad(id::text, 6, '0') WHERE number IS NULL;
INSERT INTO counters (key, year, value)
  SELECT 'prescription', extract(year FROM created_at)::int, max(id) FROM prescriptions GROUP BY 2
  ON CONFLICT (key, year) DO UPDATE SET value = greatest(counters.value, EXCLUDED.value);
ALTER TABLE prescriptions ALTER COLUMN number SET NOT NULL;
ALTER TABLE prescriptions ADD CONSTRAINT prescriptions_number_uq UNIQUE (number);

-- Délivrance d'une ligne de prescription (ligne = rang dans la liste chiffrée des médicaments)
CREATE TABLE prescription_dispensations (
  id               SERIAL PRIMARY KEY,
  prescription_id  INTEGER NOT NULL REFERENCES prescriptions(id),
  line_no          INTEGER NOT NULL CHECK (line_no > 0),
  product_id       INTEGER NOT NULL REFERENCES products(id),
  quantity         INTEGER NOT NULL CHECK (quantity > 0),
  sale_id          INTEGER NOT NULL REFERENCES pharmacy_sales(id),
  dispensed_by     INTEGER NOT NULL REFERENCES users(id),
  dispensed_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  cancelled_at     TIMESTAMPTZ,           -- vente annulée : délivrance annulée (produits remis en stock)
  cancelled_by     INTEGER REFERENCES users(id)
);
CREATE INDEX prescription_dispensations_pr_idx ON prescription_dispensations (prescription_id);
CREATE INDEX prescription_dispensations_sale_idx ON prescription_dispensations (sale_id);
CREATE INDEX pharmacy_sales_prescription_idx ON pharmacy_sales (prescription_id) WHERE prescription_id IS NOT NULL;
-- NOT VALID : contrôle des nouvelles ventes, sans réécrire les ventes historiques
ALTER TABLE pharmacy_sales ADD CONSTRAINT pharmacy_sales_prescription_fk FOREIGN KEY (prescription_id) REFERENCES prescriptions(id) NOT VALID;

-- ---------------------------------------------------------------- Factures
CREATE TABLE invoices (
  id             SERIAL PRIMARY KEY,
  site_id        INTEGER REFERENCES sites(id),
  number         TEXT NOT NULL UNIQUE,
  patient_id     INTEGER NOT NULL REFERENCES patients(id),
  notes          TEXT,
  created_by     INTEGER NOT NULL REFERENCES users(id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  cancelled_at   TIMESTAMPTZ,
  cancelled_by   INTEGER REFERENCES users(id),
  cancel_reason  TEXT
);
CREATE INDEX invoices_patient_idx ON invoices (patient_id, created_at DESC);

CREATE TABLE invoice_lines (
  id           SERIAL PRIMARY KEY,
  invoice_id   INTEGER NOT NULL REFERENCES invoices(id),
  source_type  TEXT NOT NULL CHECK (source_type IN ('consultation', 'lab_request', 'pharmacy_sale')),
  source_id    INTEGER NOT NULL,
  description  TEXT NOT NULL,
  quantity     INTEGER NOT NULL DEFAULT 1 CHECK (quantity > 0),
  unit_price   BIGINT NOT NULL CHECK (unit_price >= 0),
  active       BOOLEAN NOT NULL DEFAULT TRUE   -- FALSE lorsque la facture est annulée
);
-- un élément facturable figure sur une seule facture active
CREATE UNIQUE INDEX invoice_lines_source_active_uq ON invoice_lines (source_type, source_id) WHERE active;
CREATE INDEX invoice_lines_invoice_idx ON invoice_lines (invoice_id);

-- ---------------------------------------------------------------- Certificats médicaux
CREATE TABLE medical_certificates (
  id               SERIAL PRIMARY KEY,
  site_id          INTEGER REFERENCES sites(id),
  number           TEXT NOT NULL UNIQUE,
  patient_id       INTEGER NOT NULL REFERENCES patients(id),
  consultation_id  INTEGER REFERENCES consultations(id),
  doctor_id        INTEGER NOT NULL REFERENCES users(id),
  cert_type        TEXT NOT NULL CHECK (cert_type IN ('aptitude', 'inaptitude', 'repos', 'presence', 'autre')),
  content          TEXT NOT NULL,        -- JSON chiffré (AES-256-GCM) : texte, durée de repos, dates
  issued_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  cancelled_at     TIMESTAMPTZ,
  cancelled_by     INTEGER REFERENCES users(id),
  cancel_reason    TEXT
);
CREATE INDEX medical_certificates_patient_idx ON medical_certificates (patient_id, issued_at DESC);

-- Aucune suppression physique de ces pièces (annulation tracée uniquement)
CREATE TRIGGER prescription_dispensations_no_delete BEFORE DELETE ON prescription_dispensations FOR EACH ROW EXECUTE FUNCTION forbid_delete();
CREATE TRIGGER invoices_no_delete BEFORE DELETE ON invoices FOR EACH ROW EXECUTE FUNCTION forbid_delete();
CREATE TRIGGER invoice_lines_no_delete BEFORE DELETE ON invoice_lines FOR EACH ROW EXECUTE FUNCTION forbid_delete();
CREATE TRIGGER medical_certificates_no_delete BEFORE DELETE ON medical_certificates FOR EACH ROW EXECUTE FUNCTION forbid_delete();

-- ---------------------------------------------------------------- Laboratoire
ALTER TABLE lab_exam_types ADD COLUMN ref_min NUMERIC, ADD COLUMN ref_max NUMERIC;
ALTER TABLE lab_request_items ADD COLUMN ref_min NUMERIC, ADD COLUMN ref_max NUMERIC;
ALTER TABLE lab_requests ADD COLUMN validated_by INTEGER REFERENCES users(id), ADD COLUMN validated_at TIMESTAMPTZ;
UPDATE lab_exam_types SET ref_min = 0.70, ref_max = 1.10 WHERE code = 'GLY' AND ref_min IS NULL AND ref_max IS NULL;
UPDATE lab_exam_types SET ref_min = 6, ref_max = 12 WHERE code = 'CREA' AND ref_min IS NULL AND ref_max IS NULL;

-- ---------------------------------------------------------------- Permissions
-- (le catalogue complet est resynchronisé par l'initialisation ; ici pour les bases existantes)
SELECT set_config('sbs.context', 'system', true);
INSERT INTO permissions (code, module, label, sort_order, high_privilege) VALUES
  ('certificates.create', 'Consultations', 'Rédiger des certificats médicaux', 1000, FALSE),
  ('lab.validate', 'Laboratoire', 'Valider les résultats d''examens', 1001, FALSE)
ON CONFLICT (code) DO NOTHING;
INSERT INTO role_permissions (role_id, permission_code)
  SELECT id, 'certificates.create' FROM roles WHERE code = 'medecin' AND is_system
  ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (role_id, permission_code)
  SELECT id, 'lab.validate' FROM roles WHERE code = 'laborantin' AND is_system
  ON CONFLICT DO NOTHING;
