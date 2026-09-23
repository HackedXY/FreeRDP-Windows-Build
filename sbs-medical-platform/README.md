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

```bash
cp .env.example .env        # remplir DOMAIN, DB_PASSWORD, DATA_ENCRYPTION_KEY (openssl rand -base64 32), BACKUP_PASSPHRASE
docker compose up -d --build
docker compose logs app | grep -A2 "Compte administrateur"   # mot de passe initial si ADMIN_PASSWORD vide
```

* **HTTPS** : Caddy obtient et renouvelle automatiquement le certificat pour `DOMAIN`.
* **Sauvegardes** : service `backup` — dump quotidien chiffré (AES-256) de la base et des justificatifs dans `./backups`, rotation après `BACKUP_KEEP_DAYS` jours.
  Pour une copie **séparée du serveur principal**, synchroniser `./backups` vers un stockage distant (ex. `rclone sync ./backups distant:sbs` en cron sur l'hôte).
  Restauration : `docker compose stop app && ./deploy/restore.sh backups/sbs-db-….dump.enc && docker compose start app`.
* ⚠️ Conserver `DATA_ENCRYPTION_KEY` et `BACKUP_PASSPHRASE` **hors du serveur** (coffre, papier en lieu sûr) : sans elles, données médicales et sauvegardes sont illisibles.

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
| 32–34 | Sécurité & données médicales | HTTPS, mots de passe bcrypt + politique, mot de passe temporaire à changer, verrouillage après échecs, sessions serveur révocables (cookie httpOnly/SameSite), protection CSRF, en-têtes de sécurité, **chiffrement AES-256-GCM** des données médicales, moindre privilège (le caissier ne voit pas le dossier médical) |
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
