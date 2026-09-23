# Plateforme SBS — Cabinet Médical Sounkaro Bakary Souaré (Siguiri)

Plateforme web responsive (ordinateur, tablette, smartphone) de gestion intégrée et de supervision en temps réel du cabinet :
patients, consultations, actes, examens, prescriptions, paiements, caisse, dépenses, pharmacie, stock, employés, rendez-vous, rapports,
journal d'audit et alertes.

| Couche | Technologie |
|---|---|
| Frontend | React 18 + Vite (SPA responsive, installable comme application sur téléphone — PWA) |
| Backend | Node.js 22 + Express (API REST sécurisée) |
| Temps réel | Socket.IO (WebSocket) |
| Base de données | PostgreSQL 16 |
| Déploiement | Docker Compose + Caddy (HTTPS automatique) + sauvegardes chiffrées |

## Démarrage rapide (développement)

```bash
# 1. PostgreSQL : créer l'utilisateur et la base
createuser -P sbs          # mot de passe : sbs
createdb -O sbs sbs

# 2. API
cd backend && npm install
npm run demo               # migration + données de démonstration (facultatif)
npm run dev                # http://localhost:4000  (migrations + compte admin créés au démarrage)

# 3. Interface
cd ../frontend && npm install && npm run dev   # http://localhost:5173
```

Compte initial : `admin` / `ChangeMoi2026` (changement obligatoire à la première connexion).
Avec `npm run demo` : admin `Proprietaire2026`, employés `dr.keita`, `f.diallo`, `m.conde`, `a.toure`, `i.sylla` — mot de passe `Sbs2026demox`.

Tests d'intégration (base `sbs_test` requise) : `cd backend && npm test`.

## Mise en production

➡️ **Procédure complète pas à pas (VPS, DNS, HTTPS, secrets, sauvegardes, vérifications) : [docs/DEPLOIEMENT.md](docs/DEPLOIEMENT.md).** Résumé :

```bash
cp .env.example .env        # remplir DOMAIN, les 4 mots de passe PostgreSQL, DATA_ENCRYPTION_KEY et AUDIT_HMAC_KEY
                            # (openssl rand -base64 32), BACKUP_TARGET ; préparer secrets/ (voir « Sauvegardes »)
docker compose up -d --build   # db → migrate (identifiants propriétaire, puis s'arrête) → app, backup, caddy
docker compose logs migrate | grep -A2 "Compte administrateur"   # mot de passe initial si ADMIN_PASSWORD vide
```

* **HTTPS** : Caddy obtient et renouvelle automatiquement le certificat pour `DOMAIN`.
* **Rôles PostgreSQL séparés** : `sbs` (propriétaire, service `migrate` uniquement), `sbs_app` (application, ne peut ni altérer
  le schéma ni réécrire l'audit — l'API refuse de démarrer avec des droits propriétaire), `sbs_backup` (lecture seule).
  Mise à jour du schéma : `docker compose run --rm migrate`.
* ⚠️ Conserver `DATA_ENCRYPTION_KEY`, `AUDIT_HMAC_KEY` et la clé privée de sauvegarde **hors du serveur** (coffre, support hors ligne) : sans elles, données médicales et sauvegardes sont illisibles.

## Sauvegardes & restauration

**Principe.** Le service `backup` (rôle PostgreSQL `sbs_backup`, lecture seule) réalise chaque nuit un dump de la base
et une archive des justificatifs, **chiffrés à la volée** (AES-256-GCM ; clé de données enveloppée par une clé publique RSA-4096),
puis les envoie via **rclone vers un stockage distinct du serveur** (S3, Backblaze B2, SFTP d'un autre site…). Aucune copie en clair
n'est écrite sur disque ; le serveur ne détient **que la clé publique** et ne peut donc pas relire les sauvegardes.
Chaque exécution est inscrite dans `backup_runs` ; l'application déclenche une **alerte haute** si une sauvegarde échoue
ou si aucune n'a réussi depuis 26 h (`BACKUP_MAX_AGE_HOURS`), et la page *Paramètres* affiche l'historique.
Le manifeste de chaque sauvegarde contient l'empreinte des fichiers et l'**ancre du journal d'audit** (dernière entrée).

**Mise en place (une fois).**
```bash
mkdir -p secrets && chmod 700 secrets
# 1. Paire de clés — sur un poste de confiance ; la clé privée ne doit jamais rester sur le serveur
BACKUP_KEY_PASSPHRASE='<phrase longue>' node backend/src/backup/keygen.js --out ./cles-sauvegarde
cp ./cles-sauvegarde/backup-public.pem secrets/     # puis ranger backup-private.pem + la phrase hors ligne
# 2. Stockage distant : secrets/rclone.env (exemple S3), jamais versionné
#    RCLONE_CONFIG_DISTANT_TYPE=s3
#    RCLONE_CONFIG_DISTANT_PROVIDER=…  RCLONE_CONFIG_DISTANT_ACCESS_KEY_ID=…  RCLONE_CONFIG_DISTANT_SECRET_ACCESS_KEY=…
#    RCLONE_CONFIG_DISTANT_ENDPOINT=…
# 3. Test immédiat
docker compose run --rm backup node src/backup/worker.js --once
```
Donner au compte de stockage des droits **d'écriture sans suppression** lorsque le fournisseur le permet (verrouillage d'objets /
versionnage), afin qu'une compromission du serveur ne puisse pas effacer l'historique distant.

**Restauration (procédure testée automatiquement).**
```bash
# Sur un poste disposant de la clé privée ; base cible NEUVE créée par le propriétaire du schéma
BACKUP_TARGET=rclone:distant:sbs-sauvegardes \
RESTORE_DATABASE_URL=postgres://sbs:…@hote:5432/sbs_restauree \
BACKUP_KEY_PASSPHRASE='…' AUDIT_HMAC_KEY='…' \
node backend/src/backup/restore.js --private-key ./backup-private.pem --set latest \
     --uploads-dir /chemin/vers/uploads-vide --audit-key-env AUDIT_HMAC_KEY
```
Le script refuse une base cible non vide, vérifie les empreintes, l'authenticité du chiffrement, restaure en **une seule
transaction**, réapplique les droits applicatifs, vérifie le journal d'audit (chaîne, ancre du manifeste, signatures HMAC)
puis restaure et contrôle chaque justificatif. Pour basculer la production : arrêter `app`, restaurer dans une base neuve,
la renommer (ou pointer `DATABASE_URL` dessus), redémarrer. Tester une restauration complète **au moins une fois par mois**.

## Fonctionnalités par rapport au cahier des charges

| § | Exigence | Mise en œuvre |
|---|---|---|
| 3–5 | Employés illimités, ajout sans intervention technique | Administration → Employés → **+ Ajouter** : identifiant, mot de passe temporaire (généré), rôle, permissions individuelles, statut ; modification, réinitialisation du mot de passe, désactivation/réactivation (sessions coupées immédiatement), déverrouillage, activité, connexions, historique du compte |
| 6 | Rôles & permissions configurables | 49 permissions fines ; rôles Médecin, Infirmier, Caissier, Laborantin, Pharmacien, Administrateur ; **rôles personnalisés** ; surcharges par employé (accorder / retirer) |
| 7–8 | Tableau de bord temps réel | Indicateurs du jour, caisse théorique, personnel actif/en ligne, alertes, fil d'activité ; mise à jour **sans rechargement** via WebSocket (« Nouvelle recette : +150 000 GNF ») |
| 9 | Dossier patient | N° automatique `P-000001`, identité, contact, antécédents, allergies, groupe sanguin ; historique consultations, diagnostics, prescriptions, examens/résultats, actes, paiements, rendez-vous |
| 10, 12 | Consultations & actes | Constantes, observations, diagnostic, traitement, prescription, examens, actes facturés (catalogue tarifé), statuts médicaux et de paiement séparés, annulation motivée |
| 11 | Rendez-vous | Calendrier 7 jours, recherche, détection de conflit de créneau, annulation motivée, **rappels** (appel / SMS en un clic) |
| 13–14 | Paiements & reçus | N° de transaction et de reçu uniques, Espèces / Orange Money / MTN / virement / autre (référence obligatoire pour le mobile money), paiements partiels, remises (permission dédiée), **reçu imprimable, PDF (format ticket 80 mm) et partage** |
| 15 | Caisse | Ouverture avec solde initial, grand livre des espèces, caisse théorique calculée, clôture avec montant déclaré, **écart + justification obligatoire**, historique des clôtures ; plusieurs caisses possibles |
| 16–17 | Journal d'audit | Utilisateur, date/heure, action, élément, ancienne/nouvelle valeur, motif, IP. L'application se connecte avec un rôle PostgreSQL **non propriétaire** qui ne peut qu'**ajouter** des entrées (pas de modification, suppression, vidage ni désactivation des triggers). Chaque entrée est **chaînée (SHA-256)** et **signée (HMAC, clé hors base)** : « Vérifier l'intégrité » détecte une insertion forgée ou une réécriture faite avec les droits propriétaire, même si la chaîne a été recalculée. *Limite assumée : un attaquant disposant à la fois des droits propriétaire de la base et de la clé HMAC pourrait réécrire le journal sans être détecté — ces deux secrets ne doivent jamais se trouver ensemble hors du service de migration.* |
| 18, 29 | Alertes & notifications | Écart de caisse, remboursement, annulation, paiement modifié, remise importante, dépense inhabituelle, stock épuisé/faible, expiration proche/dépassée, correction d'inventaire, échecs de connexion répétés, accès non autorisé, changement de prix / de droits / de paramètres. Workflow « à vérifier → résolue / classée » avec note. Notifications in-app en temps réel |
| 19–21 | Pharmacie, stock, inventaire | Produits, lots et dates d'expiration, sorties **FEFO**, mouvements avec stock avant/après et auteur, justification des pertes, ventes (avec ou sans encaissement immédiat), inventaire théorique/réel avec justification des écarts |
| 22 | Laboratoire | Catalogue tarifé, demande par le médecin, file du laboratoire (urgences en tête), saisie des résultats, notification du prescripteur, paiement |
| 23–25 | Dépenses, validation, fournisseurs | Catégories, justificatif photo/PDF, **validation administrateur au-delà d'un seuil**, décaissement de caisse, fournisseurs avec historique des achats et paiements |
| 26–27 | Rapports | Quotidien / hebdo / mensuel / annuel / période libre avec évolution vs période précédente ; export CSV, impression/PDF ; **rapport par employé** (connexions, paiements, remises, annulations, modifications, clôtures, mouvements de stock) |
| 28 | Recherche globale | Patients, dossiers, reçus, paiements, consultations, médicaments, employés, examens — filtrée par permissions ; filtres de période partout |
| 30 | Mobile | Interface responsive (tableaux → cartes sur téléphone), installable (manifest PWA) |
| 31 | Hors connexion (préparation) | Paiements protégés contre les doublons par clé d'idempotence (`Idempotency-Key`) |
| 32–34 | Sécurité & données médicales | HTTPS, mots de passe bcrypt + politique, mot de passe temporaire à changer, verrouillage après échecs, sessions serveur révocables (cookie httpOnly/SameSite), protection CSRF, en-têtes de sécurité, réponses API `no-store`. **Chiffrement AES-256-GCM** (clé hors base et hors dépôt) de : antécédents, allergies, groupe sanguin, observations patient ; motif, constantes, observations, diagnostic, traitement de consultation ; **résultats d'examens** (valeur, commentaire, anomalie) et renseignements cliniques ; **prescriptions** ; motif et notes des rendez-vous. Moindre privilège par fonction (le caissier ne voit ni motif, ni résultat, ni prescription ; le pharmacien voit la prescription à délivrer ; le laboratoire voit les résultats mais pas la consultation). Fil temps réel, journal, notifications et journaux serveur **sans nom de patient ni intitulé/résultat d'examen**. *Restent en clair (nécessaires à la facturation et au stock, protégés par les contrôles d'accès) : identité du patient, type d'examen demandé, actes facturés, médicaments vendus.* |
| 37 | Évolutivité | Tables `sites` et `cash_registers` prévues (multi-site, multi-caisses), rôles et paramètres configurables, API REST |

## Structure

```
backend/src/
  db/migrations/001_schema.sql   schéma complet (36 tables, triggers d'audit)
  db/seed.js, demo.js            permissions, rôles, catalogues, admin / démo
  lib/                           auth, audit, alertes/notifications, chiffrement, stock, temps réel
  routes/                        un module par domaine (patients, paiements, caisse…)
backend/test/                    tests d'intégration (API réelle + PostgreSQL)
frontend/src/pages/              écrans par module
deploy/                          Caddyfile, sauvegarde, restauration
```

## Paramètres (Administration → Paramètres)

Seuil de validation des dépenses (défaut 500 000 GNF), seuil de dépense inhabituelle (1 500 000 GNF), pourcentage de remise
déclenchant une alerte (20 %), tolérance d'écart de caisse (0), verrouillage après 5 échecs pendant 15 min, alerte d'expiration à 60 jours,
catégories de dépenses, en-tête des reçus, caisses.

## Évolutions prévues (phase 3)

Application mobile dédiée, SMS (rappels, alertes au propriétaire), paiements électroniques intégrés (API Orange Money / MTN),
portail patient, QR code sur les reçus, mode hors ligne avec file de synchronisation, second facteur d'authentification pour l'administrateur.
