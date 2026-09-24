-- Données médicales sensibles chiffrées au repos (AES-256-GCM, clé hors base) :
--   consultations.reason, consultations.vitals (constantes, JSON chiffré)
--   lab_request_items.result (résultat, commentaire, anomalie — JSON chiffré), lab_requests.notes
--   prescriptions.items (lignes de prescription — JSON chiffré), prescriptions.notes
--   appointments.reason, appointments.notes
-- Étape 1 : nouvelles colonnes ; étape 2 (JS) : chiffrement ; étape 3 : suppression des colonnes en clair.
ALTER TABLE consultations ADD COLUMN vitals TEXT;
ALTER TABLE lab_request_items ADD COLUMN result TEXT;
ALTER TABLE prescriptions ADD COLUMN items TEXT;
