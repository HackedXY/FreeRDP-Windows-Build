# Récupération du compte propriétaire (procédure « bris de glace »)

À n'utiliser **que** si le propriétaire ne peut plus se connecter :

- mot de passe oublié ;
- ou téléphone de double authentification (2FA) perdu **et** codes de récupération indisponibles.

Dans tous les autres cas, utiliser d'abord un code de récupération à l'écran de connexion. Il reste ensuite possible de régénérer les codes ou de « changer d'appareil ».

## Principes

- **Aucune porte dérobée dans l'application.** La procédure exige un accès administrateur au serveur **et** les identifiants propriétaire de la base (service `migrate`). Le conteneur applicatif ne les détient pas.
- **Tout est tracé.** La procédure écrit une entrée signée dans le journal d'audit (`auth.owner_recovery`) et lève une alerte de sécurité haute visible par le propriétaire à sa reconnexion.
- **Contrôle à deux personnes.** L'opérateur technique exécute la procédure en présence d'un second responsable du cabinet. Le motif saisi mentionne la vérification d'identité effectuée.
- **Aucun secret n'est journalisé.** Le mot de passe temporaire s'affiche une seule fois sur le terminal de l'opérateur ; le conteneur `--rm` ne conserve aucun journal.

## Étapes

1. **Vérifier l'identité** du propriétaire en personne (pièce d'identité), en présence d'un second responsable. Noter la date, les personnes présentes et la raison.
2. Se connecter au serveur en SSH (clé personnelle de l'administrateur), puis aller dans le dossier `sbs-medigest/`.
3. Lancer la procédure (remplacer le motif) :

   ```bash
   docker compose run --rm -e AUDIT_HMAC_KEY migrate \
     node src/db/owner-recovery.js --username admin \
       --reason "Téléphone 2FA perdu — identité vérifiée par <nom> et <nom> le <date>" \
       --operator "<nom de l'opérateur>" \
       --confirm "RECUPERER admin"
   ```

   - `-e AUDIT_HMAC_KEY` transmet, pour cette seule exécution, la clé de signature du journal lue dans `.env`. Le service `migrate` ne la reçoit pas en temps normal.
   - Sans la confirmation exacte `--confirm "RECUPERER <identifiant>"`, rien n'est modifié.
4. Remettre **en main propre** le mot de passe temporaire affiché. Ne jamais l'envoyer par SMS ni par messagerie.
5. Le propriétaire se connecte, puis :
   - il choisit un nouveau mot de passe ;
   - il reconfigure immédiatement la double authentification, obligatoire en production (l'accès reste bloqué avant) ;
   - il conserve les nouveaux codes de récupération hors ligne (coffre, enveloppe scellée).
6. Contrôler le journal d'audit :
   - Journal d'audit → « Vérifier l'intégrité » : le résultat doit être OK ;
   - l'alerte « Récupération du compte propriétaire » doit apparaître. La traiter en consignant la procédure.

## Ce que fait la procédure (une seule transaction)

- Nouveau mot de passe temporaire, dont le changement est imposé à la connexion. Le compte est réactivé et déverrouillé.
- Double authentification désactivée et codes de récupération supprimés, ce qui impose une nouvelle configuration.
- Défis de connexion en cours invalidés et **toutes les sessions** du compte révoquées.
- Entrée d'audit signée et alerte haute.

## Prévention

- Imprimer les 10 codes de récupération dès l'activation de la 2FA et les ranger hors du cabinet (coffre, notaire, associé).
- Après tout usage d'un code de récupération (une alerte est levée), en régénérer une série.
- Changer d'appareil **avant** de réinitialiser l'ancien téléphone : menu « Mon compte » → « Changer d'appareil ».
