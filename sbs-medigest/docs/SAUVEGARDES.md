# Sauvegardes : stockage protégé, rétention et restauration

## 1. Principes non négociables

| Règle | Mise en œuvre |
|---|---|
| Sauvegardes **hors du serveur** | Service `backup` → rclone vers un stockage objet distant (S3 compatible, Backblaze B2…). La cible `dir:` est refusée en production. |
| Le serveur **ne peut pas relire** les sauvegardes | Chiffrement AES-256-GCM à la volée ; la clé de données est enveloppée par une **clé publique** RSA. La clé **privée** n'est jamais sur le serveur : le service refuse de démarrer si une clé privée lui est fournie, et `preflight.sh` échoue si une clé privée se trouve dans `secrets/`. |
| Le serveur **ne peut pas effacer** l'historique | Identifiants de stockage **sans droit de suppression** et **verrouillage d'objets** (WORM). `BACKUP_REMOTE_PRUNE=off` : le serveur ne tente aucune suppression. La rétention est confiée au stockage. |
| Chaque sauvegarde est **vérifiable** | Manifeste (empreintes SHA-256, empreinte de la clé, ancre du journal d'audit). Chaque exécution est tracée dans `backup_runs`, avec une alerte haute en cas d'échec ou d'absence de sauvegarde depuis plus de 26 h. |

## 2. Stockage distant protégé (exemple : Backblaze B2 ou S3 avec Object Lock)

1. Créer un bucket **privé** dédié, par exemple `sbs-sauvegardes`, **avec Object Lock activé** (à la création du bucket).
2. Rétention par défaut du bucket : mode **Compliance** (ou *Governance* à défaut), **35 jours**. Pendant cette durée, aucun objet ne peut être supprimé ni écrasé, même avec les identifiants du propriétaire du compte.
3. Règle de **cycle de vie** : suppression automatique des versions de plus de **400 jours** (13 mois).
4. Créer une **clé applicative limitée à ce bucket** pour le serveur :
   - droits : `listBuckets`, `listFiles`, `readFiles`, `writeFiles` ;
   - **sans** `deleteFiles` ni gestion des verrouillages ou du cycle de vie. Sur S3 : `s3:PutObject`, `s3:GetObject`, `s3:ListBucket`, **pas** de `s3:DeleteObject*` ni de `s3:PutBucket*`.
5. Mettre ces identifiants dans `secrets/rclone.env` (permissions 600, jamais versionné) :

   ```
   RCLONE_CONFIG_DISTANT_TYPE=s3
   RCLONE_CONFIG_DISTANT_PROVIDER=Other          # ou AWS, Wasabi…
   RCLONE_CONFIG_DISTANT_ACCESS_KEY_ID=…
   RCLONE_CONFIG_DISTANT_SECRET_ACCESS_KEY=…
   RCLONE_CONFIG_DISTANT_ENDPOINT=https://s3.<région>.backblazeb2.com
   RCLONE_CONFIG_DISTANT_NO_CHECK_BUCKET=true
   ```
6. **Vérifier la protection** depuis le serveur : la commande suivante doit échouer (accès refusé ou objet verrouillé).

   ```
   docker compose run --rm --entrypoint rclone backup delete distant:sbs-sauvegardes/<un jeu>/manifest.json
   ```

## 3. Stratégie de rétention

| Niveau | Fréquence | Conservation | Où |
|---|---|---|---|
| Quotidien | chaque nuit (`BACKUP_HOUR`, défaut 2 h), avec rattrapage si plus de 24 h | 35 jours verrouillés, puis 13 mois au total | stockage objet distant |
| Mensuel hors ligne | 1er du mois | 12 mois minimum | copie sur disque chiffré conservé hors du cabinet (responsable désigné) |
| Avant mise à jour | à chaque `docker compose run --rm migrate` | selon le quotidien | déclencher `worker.js --once` juste avant |

Copie mensuelle hors ligne : depuis le poste de confiance, `rclone copy distant:sbs-sauvegardes/<jeu> /media/disque-chiffre/<jeu>`. Les fichiers restent chiffrés ; le poste n'a pas besoin de la clé privée pour copier.

## 4. Garde des clés

- `backup-private.pem` et sa phrase de passe sont **deux secrets distincts**, conservés séparément :
  - la clé : sur une clé USB chiffrée, au coffre, plus une seconde copie chez un associé ou un notaire ;
  - la phrase : dans le gestionnaire de mots de passe du propriétaire, plus une copie papier sous enveloppe scellée.
- `DATA_ENCRYPTION_KEY` et `AUDIT_HMAC_KEY` (fichier `.env` du serveur) : une copie hors ligne au coffre. **Sans `DATA_ENCRYPTION_KEY`, les données médicales restaurées sont illisibles.**
- Ne jamais copier la clé privée sur le serveur, ni l'envoyer par e-mail ou messagerie.

## 5. Procédure de restauration

### 5.1 Exercice mensuel (obligatoire), sans toucher à la production

1. Sur le **poste de confiance** (qui détient la clé privée), démarrer un PostgreSQL 16 jetable :

   ```
   docker run -d --name sbs-restau -e POSTGRES_PASSWORD=<tmp> -p 127.0.0.1:55432:5432 postgres:16-alpine
   ```

   Y créer les rôles `sbs`, `sbs_app` et `sbs_backup`, ainsi qu'une base vide `sbs_restauree` appartenant à `sbs`, comme le fait `deploy/db-init/01-roles.sh`.
2. Restaurer et vérifier :

   ```
   BACKUP_TARGET=rclone:distant:sbs-sauvegardes \
   RESTORE_DATABASE_URL=postgres://sbs:<mdp>@127.0.0.1:55432/sbs_restauree \
   BACKUP_KEY_PASSPHRASE='<phrase>' AUDIT_HMAC_KEY='<clé>' \
   node backend/src/backup/restore.js --private-key ./backup-private.pem --set latest \
        --uploads-dir ./uploads-restaures --audit-key-env AUDIT_HMAC_KEY
   ```

   Le script contrôle :
   - les empreintes des fichiers et l'authenticité du chiffrement ;
   - une restauration en une seule transaction ;
   - la réapplication des droits applicatifs ;
   - la chaîne, l'ancre et les signatures du journal d'audit ;
   - chaque justificatif restauré.

   Il refuse une base cible non vide.
3. Consigner la date, le jeu restauré et le résultat (registre des exercices). Détruire ensuite le conteneur et les fichiers restaurés : `docker rm -f sbs-restau` et `rm -rf ./uploads-restaures`.

### 5.2 Restauration de production (sinistre)

1. **Sauvegarder l'état courant** s'il est lisible : `docker compose run --rm backup node src/backup/worker.js --once`.
2. Arrêter l'application : `docker compose stop app backup`.
3. Créer une base neuve `sbs_restauree`, propriété de `sbs`, dans le conteneur `db` :

   ```
   docker compose exec db psql -U postgres -c 'CREATE DATABASE sbs_restauree OWNER sbs'
   ```
4. Depuis le poste de confiance, via un tunnel SSH vers le port PostgreSQL (jamais exposé sur Internet), exécuter la commande du § 5.1 avec cette base. Restaurer les justificatifs dans un dossier vide, puis les copier dans le volume `uploads`.
5. Basculer :

   ```
   ALTER DATABASE sbs RENAME TO sbs_ancienne;
   ALTER DATABASE sbs_restauree RENAME TO sbs;
   ```

   Puis lancer `docker compose run --rm migrate` pour les migrations éventuelles et `docker compose up -d`.
6. Contrôles :
   - `deploy/scripts/verify.sh` ;
   - Journal d'audit → « Vérifier l'intégrité » ;
   - un paiement de test annulé.

   Conserver `sbs_ancienne` au moins 30 jours avant suppression.

## 6. Surveillance

- Dans la page *Paramètres → Sauvegardes* : historique des exécutions.
- Alertes hautes automatiques : échec, ou aucune sauvegarde réussie depuis `BACKUP_MAX_AGE_HOURS` (26 h).
- Chaque trimestre : vérifier dans la console du fournisseur que le verrouillage et le cycle de vie sont toujours actifs.
