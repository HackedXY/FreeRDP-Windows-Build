# Déploiement de la plateforme SBS sur un VPS (HTTPS)

Procédure pas à pas pour mettre la plateforme en ligne sur un serveur privé virtuel, avec certificat HTTPS
automatique (Let's Encrypt), sauvegardes chiffrées hors serveur et accès restreint aux seuls ports 80/443.

> **Avant d'y mettre des données réelles de patients**, lisez la section *Risques résiduels* : plusieurs
> points de sécurité de niveau moyen restent ouverts et doivent être acceptés ou corrigés par le propriétaire.

---

## 0. Ce qu'il faut réunir

| Élément | Recommandation |
|---|---|
| **VPS** | Ubuntu 24.04 LTS, 2 vCPU, 4 Go de RAM, 40 Go SSD minimum. Centre de données proche de Siguiri pour la latence (ex. Europe de l'Ouest : Paris, Francfort) ou en Afrique de l'Ouest si disponible. |
| **Nom de domaine** | Un sous-domaine dédié, ex. `sbs.mondomaine.gn`, dont vous contrôlez la zone DNS. |
| **Stockage des sauvegardes** | Un service distinct du VPS, **chez un autre fournisseur ou dans une autre région** : S3 compatible (Backblaze B2, Scaleway, OVH, AWS…) ou SFTP d'un autre site. Activez si possible le **verrouillage d'objets / versionnage**. |
| **Poste de confiance** | L'ordinateur du propriétaire, qui détiendra la **clé privée** de sauvegarde (jamais sur le serveur). |
| **Coffre hors ligne** | Clé USB chiffrée au coffre + copie papier : clés `DATA_ENCRYPTION_KEY`, `AUDIT_HMAC_KEY`, clé privée de sauvegarde et sa phrase secrète. |
| **Accès SSH** | Une clé SSH (pas de mot de passe). |

Vérifiez aussi les **obligations locales** relatives à l'hébergement de données de santé et à la protection des
données personnelles (autorité nationale compétente, consentement des patients, lieu d'hébergement).

---

## 1. DNS

Chez votre registraire, créez un enregistrement **A** `sbs.mondomaine.gn` → adresse IPv4 du VPS
(et **AAAA** si le VPS a une IPv6). Attendez la propagation (`dig +short sbs.mondomaine.gn`).
Let's Encrypt ne délivrera le certificat qu'une fois le domaine pointé vers le serveur.

## 2. Préparer le serveur (une fois)

```bash
ssh root@IP_DU_VPS
curl -fsSLO https://raw.githubusercontent.com/<compte>/<depot>/<branche>/sbs-medical-platform/deploy/scripts/setup-vps.sh
less setup-vps.sh                     # relisez-le avant de l'exécuter
sudo bash setup-vps.sh --harden-ssh   # --harden-ssh seulement si votre clé SSH est déjà installée
```

Le script : mises à jour automatiques de sécurité, fuseau `Africa/Conakry`, swap si < 4 Go, Docker + Compose,
pare-feu **ufw (22, 80, 443 uniquement)**, fail2ban, utilisateur d'exploitation `sbs`, et en option
désactivation de la connexion SSH par mot de passe.

## 3. Récupérer le code

```bash
su - sbs
git clone -b <branche> https://github.com/<compte>/<depot>.git sbs-app
cd sbs-app/sbs-medical-platform
```
Dépôt privé : utilisez une **clé de déploiement en lecture seule** (GitHub → Settings → Deploy keys).

## 4. Générer les secrets

```bash
./deploy/scripts/generate-secrets.sh sbs.mondomaine.gn exploitation@mondomaine.gn rclone:distant:sbs-sauvegardes
```

Crée `.env` (droits 600) avec des mots de passe PostgreSQL distincts par rôle, la clé de chiffrement des données
médicales, la clé de signature du journal d'audit et un mot de passe initial pour le propriétaire.
**Aucun secret n'est affiché.** Ensuite :

- recopiez `DATA_ENCRYPTION_KEY` et `AUDIT_HMAC_KEY` dans le **coffre hors ligne** (sans elles : données médicales
  illisibles et journal invérifiable après une restauration) ;
- lisez une seule fois le mot de passe initial : `grep '^ADMIN_PASSWORD=' .env` (changement imposé à la première connexion).

## 5. Sauvegardes hors serveur

**Sur le poste de confiance** (pas sur le VPS) — Node.js 20+ requis :
```bash
cd sbs-medical-platform/backend
BACKUP_KEY_PASSPHRASE='<phrase longue, notée au coffre>' node src/backup/keygen.js --out ./cles-sbs
scp ./cles-sbs/backup-public.pem sbs@IP_DU_VPS:sbs-app/sbs-medical-platform/secrets/
# backup-private.pem reste sur le poste de confiance + copie au coffre
```

**Sur le VPS**, identifiants du stockage distant dans `secrets/rclone.env` (droits 600), exemple S3 :
```bash
cat > secrets/rclone.env <<'EOF'
RCLONE_CONFIG_DISTANT_TYPE=s3
RCLONE_CONFIG_DISTANT_PROVIDER=Other
RCLONE_CONFIG_DISTANT_ENDPOINT=https://s3.fournisseur.example
RCLONE_CONFIG_DISTANT_ACCESS_KEY_ID=...
RCLONE_CONFIG_DISTANT_SECRET_ACCESS_KEY=...
EOF
chmod 600 secrets/rclone.env
```
Donnez à cette clé d'accès les droits minimaux sur un seul compartiment (idéalement écriture sans suppression
définitive, grâce au versionnage / verrouillage d'objets).

## 6. Contrôles préalables

```bash
./deploy/scripts/preflight.sh
```
Vérifie : Docker/Compose ≥ 2.24, `.env` complet et en 600, clés de 32 octets distinctes, mots de passe distincts,
cible de sauvegarde distante, clé publique valide, **absence de clé privée sur le serveur**, `rclone.env` en 600,
aucun secret suivi par git, DNS pointant vers ce serveur, ports 80/443 libres, pare-feu actif sans port interne,
configuration Compose valide et **seuls 80/443 publiés**. Corrigez chaque ✖ avant de continuer.

## 7. Démarrage

```bash
docker compose up -d --build
docker compose logs -f migrate      # migrations + compte propriétaire, puis le service s'arrête (code 0)
docker compose ps                   # db, app, backup, caddy : « running » ; migrate : « exited (0) »
docker compose logs caddy | grep -i certificate   # certificat Let's Encrypt obtenu
```

Ordre : `db` (rôles créés par `deploy/db-init`) → `migrate` (seul service avec les identifiants propriétaire)
→ `app` (rôle restreint ; refuse de démarrer avec des droits propriétaire) + `backup` + `caddy`.

## 8. Vérification

Depuis votre poste (pas depuis le VPS) :
```bash
./deploy/scripts/verify.sh sbs.mondomaine.gn
```
Contrôle : HTTPS et certificat, redirection HTTP→HTTPS, en-têtes de sécurité (HSTS, CSP…), API protégée,
protection CSRF, WebSocket temps réel via Caddy et refus des origines étrangères, ports 5432/4000/5173 fermés.

Puis, dans le navigateur (ordinateur et téléphone) :
1. se connecter avec `admin` et le mot de passe initial → **changer le mot de passe** ;
2. Paramètres → vérifier l'en-tête des reçus et les seuils ;
3. Employés → créer les comptes réels (chacun changera son mot de passe temporaire) ;
4. Paramètres → *Sauvegardes* : une première sauvegarde réussie doit apparaître quelques minutes après le démarrage.

> **Normal au premier démarrage** : l'alerte haute « Aucune sauvegarde réussie enregistrée » peut apparaître avant la
> première sauvegarde ; elle se résout d'elle-même au contrôle horaire suivant.

⚠️ **Ne lancez jamais `npm run demo` en production** : il crée des comptes au mot de passe public.

## 9. Test de restauration (obligatoire avant les données réelles, puis chaque mois)

Sur le poste de confiance, avec un PostgreSQL local et une base **neuve** :
```bash
createdb -O <proprietaire_local> sbs_test_restauration
RCLONE_CONFIG_DISTANT_TYPE=s3 ... \
BACKUP_TARGET=rclone:distant:sbs-sauvegardes \
RESTORE_DATABASE_URL=postgres://<proprietaire_local>:...@localhost:5432/sbs_test_restauration \
BACKUP_KEY_PASSPHRASE='…' AUDIT_HMAC_KEY='…' \
node src/backup/restore.js --private-key ./cles-sbs/backup-private.pem --uploads-dir ./restauration-uploads --audit-key-env AUDIT_HMAC_KEY
```
Chaque étape doit afficher ✔ (empreintes, authentification du chiffrement, journal d'audit, justificatifs).

## 10. Exploitation courante

| Tâche | Commande / action |
|---|---|
| État des services | `docker compose ps` |
| Journaux | `docker compose logs --tail 200 app` (rotation automatique : 5 × 10 Mo par service) |
| Surveillance externe | Sonde de disponibilité (ex. UptimeRobot) sur `https://sbs.mondomaine.gn/api/health` |
| Sauvegardes | Paramètres → *Sauvegardes* ; alerte haute automatique en cas d'échec ou de retard > 26 h |
| Intégrité de l'audit | Journal d'audit → *Vérifier l'intégrité* (chaîne + signatures) |
| Certificat | Renouvelé automatiquement par Caddy |
| Mises à jour système | Automatiques (unattended-upgrades) ; redémarrage du VPS à planifier hors heures d'ouverture |

### Mettre à jour l'application
```bash
cd ~/sbs-app && git fetch && git log --oneline HEAD..origin/<branche>   # relire les changements
docker compose -f sbs-medical-platform/docker-compose.yml run --rm backup node src/backup/worker.js --once  # sauvegarde avant mise à jour
git pull
cd sbs-medical-platform
docker compose build
docker compose run --rm migrate      # migrations éventuelles
docker compose up -d
./deploy/scripts/verify.sh sbs.mondomaine.gn
```

### Revenir en arrière
- Sans changement de schéma : `git checkout <commit précédent>` puis `docker compose up -d --build`.
- Avec changement de schéma : restaurer la sauvegarde prise juste avant la mise à jour (section 9, dans une base
  neuve), pointer l'application dessus, puis redéployer la version précédente.

## 11. Risques résiduels (à décider par le propriétaire avant les données réelles)

Issus de l'audit de préparation à la production (aucun risque « élevé » restant) :

| Réf. | Risque | Recommandation |
|---|---|---|
| M-10 | Pas de double authentification pour le propriétaire | À ajouter avant l'ouverture sur Internet (accès distant au compte le plus privilégié) |
| M-2 / M-3 | Verrouillage de compte détournable (le propriétaire peut être bloqué 15 min) ; limite de connexion par IP partagée par tout le cabinet | Corriger avant l'ouverture, ou restreindre l'accès par IP |
| M-1 | L'écran de connexion révèle si un compte est désactivé/verrouillé | Correction simple |
| M-13 | Pas d'expiration de session sur inactivité (12 h) | Important sur les postes partagés de l'accueil |
| M-4 à M-8 | Contrôles financiers (journées clôturées modifiables, décaissements sans plafond journalier, fonds entre deux caisses, ventes impayées) | Procédures internes en attendant les corrections |
| M-9 | Consultations de dossiers médicaux non tracées | À prévoir |
| N-1 / N-2 | Le service de migration détient à la fois les droits propriétaire et la clé d'audit ; les identifiants du stockage distant permettent la suppression | Protéger `.env` ; activer le verrouillage d'objets chez le fournisseur |

## Validé en répétition

La procédure a été répétée sur une machine de test (hors Docker, les images ne pouvant y être téléchargées) avec la
configuration de production : génération des secrets, provisionnement des rôles PostgreSQL par `deploy/db-init`,
migrations en `NODE_ENV=production`, refus de démarrage avec des droits propriétaire ou une clé manquante, Caddyfile
réel en HTTPS (autorité interne à la place de Let's Encrypt), `verify.sh` (en-têtes, CSRF, WebSocket, redirection),
parcours complet navigateur (première connexion, changement de mot de passe, création d'employé, encaissement sur
mobile, mise à jour temps réel en WSS, cookie `Secure/HttpOnly/SameSite=Strict`), sauvegarde de production vers
rclone puis restauration vérifiée. **Restent à valider sur le vrai VPS** : la construction des images Docker, l'obtention
du certificat Let's Encrypt et l'envoi vers votre fournisseur de stockage réel.
