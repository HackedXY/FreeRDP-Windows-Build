-- Phase 4 : mentions des documents médicaux (à valider par le médecin)
-- N° d'inscription à l'Ordre (ou autorisation d'exercice) imprimé sur ordonnances et certificats.
ALTER TABLE users ADD COLUMN professional_id TEXT;
