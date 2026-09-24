-- Phase 4 : index justifiés par mesure (base de 20 000 patients / 60 000 consultations,
-- voir le rapport de performance). Chaque ligne affichée d'une liste déclenchait un
-- parcours complet de ces tables (sous-requête par ligne) : ≈ 3 ms × 50 lignes par page.
CREATE INDEX IF NOT EXISTS pharmacy_sale_items_sale_idx ON pharmacy_sale_items (sale_id);     -- liste des ventes, annulation, rapports
CREATE INDEX IF NOT EXISTS lab_request_items_request_idx ON lab_request_items (request_id);    -- liste / fiche des demandes d'examens
CREATE INDEX IF NOT EXISTS consultation_acts_consultation_idx ON consultation_acts (consultation_id); -- fiche consultation, montants
