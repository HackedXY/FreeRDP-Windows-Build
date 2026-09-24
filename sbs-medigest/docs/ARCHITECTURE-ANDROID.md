# Architecture prévue pour une application Android (préparation, sans application native)

La plateforme est aujourd'hui **installable sur Android comme application web progressive (PWA)** :

- manifeste, icônes (dont l'icône « maskable ») et écran de démarrage généré par Android ;
- service worker qui ne conserve que l'interface.

Ce document fixe les règles d'une future application native **avant** sa réalisation. Il décrit aussi ce que l'API fournit déjà.

## 1. Étapes recommandées

1. **Maintenant — PWA** : « Ajouter à l'écran d'accueil » depuis Chrome. Aucune donnée n'est conservée sur l'appareil.
2. **Ensuite — TWA** (*Trusted Web Activity*, Bubblewrap) : la PWA est publiée sur le Play Store avec le même code web. Il faut ajouter `/.well-known/assetlinks.json` pour prouver le lien entre le domaine et l'application.
3. **Plus tard — application native** (Kotlin, ou Capacitor si le code web est réutilisé), seulement si un besoin l'exige :
   - notifications push fiables ;
   - scanner de codes-barres pour la pharmacie ;
   - fonctionnement hors ligne contrôlé ;
   - intégration d'une imprimante Bluetooth.

## 2. Ce que l'API offre déjà

| Besoin mobile | Existant |
|---|---|
| Échanges | API JSON (`/api/*`) ; fichiers PDF générés par le serveur. |
| Authentification sans cookie | `Authorization: Bearer <jeton>` accepté (`tokenFromRequest`). Une requête qui le porte n'a pas besoin de l'en-tête anti-CSRF. |
| Double authentification | Connexion en deux étapes en JSON (`/auth/login` → `mfa_token` → `/auth/login/mfa`). |
| Sessions | Jeton opaque, seule son empreinte SHA-256 est en base. Durée maximale de 12 h et expiration après inactivité. Révocation immédiate : déconnexion, désactivation du compte, changement de mot de passe. |
| Tâches en arrière-plan | L'en-tête `X-SBS-Background: 1` évite qu'une synchronisation automatique prolonge la session. |
| Écritures rejouables | L'en-tête `Idempotency-Key` sur les encaissements empêche les doublons après une coupure réseau. |
| Temps réel | Socket.IO, avec authentification par `auth.token` à la connexion et droits vérifiés à chaque envoi. |
| Contrôle d'accès | Permissions vérifiées côté serveur et journal des lectures de dossiers médicaux : l'application ne peut pas voir plus que le rôle de l'utilisateur. |

## 3. À ajouter côté serveur au moment du projet natif

1. **Connexion mobile** : `POST /api/auth/mobile/login`. Même contrôle que le web (limitation, 2FA), mais le jeton est renvoyé dans la réponse au lieu d'un cookie. La table `sessions` reçoit les colonnes `client` (`android/<version>`) et `device_id` (identifiant d'installation).
   - Durée courte (12 h, inactivité 30 min).
   - Aucun jeton « permanent » : on se reconnecte, avec déverrouillage biométrique local.
2. **Appareils et notifications push** : table `devices` (`user_id`, `device_id`, jeton FCM **chiffré**, `created_at`, `last_seen_at`, `revoked_at`) et routes `POST/DELETE /api/devices`. L'écran « Employés » liste et révoque les appareils. La révocation ferme aussi les sessions de l'appareil.
3. **Contenu des notifications** : **aucune donnée médicale ni nominative** dans la charge FCM, qui transite par Google. Uniquement un type et un identifiant (« Nouvelle notification »). Le contenu est lu ensuite par l'API authentifiée.
4. **Versionnement** : alias `/api/v1`. L'en-tête `X-SBS-Client: android/<version>` permet de refuser une version trop ancienne (426 + message de mise à jour).
5. **Synchronisation incrémentale** : paramètre `?since=<horodatage>` sur les listes de référence (catalogue d'actes et d'examens, produits et stocks), avec un `updated_at` indexé.

## 4. Règles côté application Android

- **Stockage du jeton** : `EncryptedSharedPreferences`, avec une clé dans l'**Android Keystore** matériel. Jamais dans les journaux, jamais en clair. Effacement à la déconnexion ou à la révocation (401).
- **Réseau** : HTTPS uniquement (`network_security_config`, trafic en clair interdit) et **épinglage du certificat** (clé publique de l'autorité Let's Encrypt, avec une clé de secours).
- **Écran** : `FLAG_SECURE` sur les écrans médicaux (pas de capture ni d'aperçu dans les applications récentes). Verrouillage automatique après inactivité, aligné sur le serveur.
- **Appareil** : refus ou avertissement sur un appareil rooté ou non chiffré. Gestion de flotte (MDM) recommandée pour les téléphones du cabinet.

## 5. Mode hors ligne contrôlé

| Donnée | Hors ligne ? | Règle |
|---|---|---|
| Interface, catalogue d'actes et d'examens, liste des produits (sans prix d'achat) | Oui | Cache en lecture, rafraîchi à chaque connexion. |
| Dossiers médicaux, consultations, résultats, prescriptions | **Non** par défaut | Affichage en ligne uniquement. Une exception éventuelle (tournée sans réseau) demande l'accord du médecin responsable. Elle passerait par une base chiffrée (SQLCipher, clé dans le Keystore), une durée de vie de 8 h au plus, un effacement à la révocation et une journalisation des consultations à la reconnexion. |
| Encaissements, ventes | File d'attente locale | Chaque opération porte un `Idempotency-Key` et **n'est comptabilisée qu'à sa réception par le serveur**. Les contrôles de caisse (solde, plafond, clôture) restent faits côté serveur. En cas de refus (caisse clôturée…), l'opération est signalée à l'utilisateur, jamais forcée. |
| Journal d'audit | Non | Toujours écrit par le serveur. |

## 6. Ce qui ne doit jamais changer

- Le serveur reste **la seule source de vérité** pour les permissions, la caisse, l'audit et le chiffrement des données médicales.
- Aucune clé serveur (`DATA_ENCRYPTION_KEY`, `AUDIT_HMAC_KEY`, clés de sauvegarde) dans l'application.
- La 2FA du propriétaire s'applique aussi sur mobile.
