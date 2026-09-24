# Modèles de documents : fiche de validation (médecin et gérant)

Les cinq documents ci-dessous sont générés par la plateforme. **Avant la mise en service avec de vrais patients**, le médecin responsable et le gérant doivent valider chaque modèle. Cette validation couvre :

- les mentions légales ;
- les mentions professionnelles ;
- l'emplacement du cachet et de la signature.

Les rubriques marquées ☐ sont à cocher, dater et signer. Les exemples PDF (données fictives) sont fournis séparément pour relecture.

> **Rien dans ce document ne constitue un avis juridique.** Les mentions obligatoires en République de Guinée (Code de la santé publique, Ordre national des médecins de Guinée, réglementation fiscale) doivent être confirmées par le médecin responsable et, pour la facture, par le comptable.

## Paramètres à renseigner avant validation

| Où | Champ | Utilisé sur |
|---|---|---|
| Paramètres → Cabinet | Nom, raison sociale, adresse, ville, téléphone | tous les documents |
| Paramètres → Cabinet | N° d'autorisation / d'agrément du cabinet | tous les documents (en-tête) |
| Paramètres → Cabinet | NIF, RCCM | facture, reçu |
| Paramètres → Cabinet | Mention de pied de page | tous les documents A4 |
| Employés → fiche du médecin | Fonction (spécialité), **n° d'inscription à l'Ordre** | ordonnance, certificat |

## 1. Ordonnance (`ORD-AAAA-NNNNNN`, A4)

Contenu actuel :

- identité du cabinet et numéro unique ;
- date ;
- patient : nom, n° de dossier, âge, sexe ;
- prescripteur : nom, fonction, n° d'Ordre ;
- pour chaque médicament : désignation, quantité, posologie, durée et instructions ;
- recommandations ;
- zone « signature et cachet » ;
- code de vérification en pied de page.

☐ Mentions du prescripteur complètes (nom, qualification, n° d'Ordre, adresse professionnelle)
☐ Identification du patient suffisante (faut-il ajouter le poids pour la pédiatrie ?)
☐ Dénomination des médicaments : commune internationale (DCI) et/ou nom commercial
☐ Durée de validité de l'ordonnance à imprimer ? (texte à fournir)
☐ Emplacement de la signature manuscrite et du cachet
☐ Faut-il une mention pour les produits soumis à réglementation particulière ?

## 2. Certificat médical (`CERT-AAAA-NNNNNN`, A4)

Types : aptitude, inaptitude, arrêt ou repos, présence ou consultation, autre. Le texte est rédigé par le médecin, et la formule « Je soussigné(e)… certifie avoir examiné ce jour… » est ajoutée automatiquement.

Pour un arrêt ou un repos : nombre de jours, date de début et date de fin. Viennent ensuite « Fait à <ville>, le <date> », le nom du médecin, son n° d'Ordre et la zone « signature et cachet ».

☐ Formule d'attestation conforme aux usages de l'Ordre
☐ Mention « établi à la demande de l'intéressé(e) et remis en main propre » conservée ?
☐ Le certificat de repos doit-il mentionner le motif ? (secret médical : par défaut **non**)
☐ Mentions spécifiques pour l'aptitude au sport ou au travail (texte type à fournir)
☐ Signature et cachet

## 3. Compte rendu d'examens de laboratoire (`LAB-AAAA-NNNNNN`, A4)

Contenu actuel :

- patient, prescripteur, n° de demande, dates de prélèvement et de résultat ;
- pour chaque examen : désignation, résultat, unité, valeurs de référence et marqueur (H) ou (B) ;
- commentaires éventuels ;
- mention « validé par … le … », ou filigrane « RÉSULTATS NON VALIDÉS ».

☐ Valeurs de référence du catalogue vérifiées pour chaque examen (Actes & tarifs → Examens)
☐ Faut-il des valeurs de référence selon le sexe ou l'âge ? (non gérées actuellement)
☐ Qualité du signataire de la validation (technicien, biologiste ou médecin)
☐ Mention d'interprétation par le prescripteur conservée
☐ Signature et cachet du laboratoire

## 4. Facture (`FAC-AAAA-NNNNNN`, A4)

Contenu actuel :

- cabinet, NIF et RCCM ;
- patient ;
- lignes de consultation, d'examens et de pharmacie avec montant, part payée et reste ;
- total, remises, montant payé, solde et statut ;
- historique des paiements avec leurs n° de reçu.

☐ Mentions fiscales obligatoires : NIF, RCCM, régime de TVA — **les prestations médicales sont-elles exonérées ?** Si oui, faut-il la mention « TVA non applicable » ?
☐ Conditions et échéance de paiement à imprimer ?
☐ Numérotation continue sans trou : le numéro est annuel (`FAC-2026-…`) et une facture annulée reste archivée
☐ Faut-il détailler les actes (et non seulement « Consultation n° … ») ? Attention au secret médical si la facture est remise à un tiers payeur

## 5. Reçu de paiement (`REC-AAAA-NNNNNN`, ticket 80 mm)

Contenu actuel :

- cabinet, NIF et RCCM ;
- n° de reçu, référence, date et heure ;
- patient ;
- prestation, montant, remise et total ;
- mode de paiement et référence de transaction ;
- caissier ;
- mention « ANNULÉ » ou « REMBOURSÉ » si applicable.

☐ Mentions légales du reçu
☐ Format 80 mm adapté à l'imprimante du cabinet (test d'impression)
☐ Faut-il un double pour la comptabilité ?

## Validation

| Document | Validé par (nom, fonction) | Date | Signature | Remarques |
|---|---|---|---|---|
| Ordonnance | | | | |
| Certificat médical | | | | |
| Compte rendu de laboratoire | | | | |
| Facture | | | | |
| Reçu | | | | |

Toute modification demandée est reportée dans un ticket de développement. Le document validé est ensuite archivé avec ces exemples.
