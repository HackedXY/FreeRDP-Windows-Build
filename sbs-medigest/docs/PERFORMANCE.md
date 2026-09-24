# Performance : mesures et optimisations (phase 4)

## Méthode

J'ai créé une base dédiée `sbs_perf`, séparée des bases de test et de démonstration, et je l'ai remplie de données **fictives** en volume :

- 20 000 patients et 60 000 consultations avec leurs actes ;
- 30 000 ventes de pharmacie (60 000 lignes) ;
- 20 000 demandes d'examens (40 000 lignes) ;
- 72 000 paiements ;
- 5 000 factures (15 000 lignes) ;
- 20 000 rendez-vous ;
- 50 000 entrées d'audit.

Chaque point d'accès a été appelé 5 fois par l'API réelle (session administrateur) ; le tableau donne la **médiane** et le **nombre de requêtes SQL**.

## Résultats

| Point d'accès | Avant | Après | Requêtes SQL avant → après | Cause / correction |
|---|---|---|---|---|
| `GET /dashboard` | 671 ms | **42 ms** | 11 → 11 | Série sur 7 jours sous forme de sous-requêtes corrélées, avec une estimation de 1 000 lignes ⇒ **compilation JIT** (≈ 300 ms). Réécrite en agrégats groupés ; JIT désactivé pour les connexions applicatives. |
| `GET /reports/summary?period=year` | 731 ms | **120 ms** | 15 → 15 | Même cause : 365 jours × 3 sous-requêtes, réécrites en 3 agrégats. |
| `GET /consultations` | 203 ms | **14 ms** | 6 → 7 | `count(*) OVER()` joignait les 60 000 lignes avant d'en garder 50 : la page (index de date) et le comptage sont maintenant séparés. |
| `GET /pharmacy/sales` | 232 ms | **57 ms** | 2 → 2 | Index manquant : `pharmacy_sale_items(sale_id)`. Chaque ligne de page parcourait toute la table. |
| `GET /lab/requests` | 168 ms | **62 ms** | 2 → 2 | Index manquant : `lab_request_items(request_id)`. |
| `GET /invoices` | 121 ms | **18 ms** | **152 → 3** | **N+1** : une série de requêtes par facture. Totaux et statut calculés en SQL pour la page. |
| `GET /patients/:id/history` | 26 ms | 18 ms | 12 → 12 | Index `consultation_acts(consultation_id)`, également utilisé par la fiche consultation. |
| `GET /patients`, `/payments`, `/appointments`, `/search` | 23–35 ms | inchangé | 2–8 | Correct à ce volume. |

## Index ajoutés (migration `013_performance_indexes.sql`)

Seuls des index **justifiés par une mesure** ont été ajoutés :

- `pharmacy_sale_items (sale_id)` ;
- `lab_request_items (request_id)` ;
- `consultation_acts (consultation_id)`.

## Non retenus (volume d'un cabinet)

- **Recherche texte** (`?q=`, `LIKE '%…%'` sur nom ou prénom) : 35 ms sur les patients, 108 ms sur les consultations. Un index trigramme (`pg_trgm`) ne se justifie qu'au-delà de 100 000 patients.
- **`pharmacy_sales(created_at)`** : un parcours de 30 000 lignes prend environ 5 ms.
- **Autres `count(*) OVER()`** (patients, paiements) : moins de 35 ms. À revoir si le volume décuple.

## Tests de non-régression

`backend/test/performance.test.js` vérifie :

- le nombre de requêtes constant de la liste des factures ;
- la cohérence entre la liste et la fiche des factures ;
- les totaux de pagination ;
- l'exactitude des séries journalières ;
- la présence des index ;
- la valeur `jit=off`.
