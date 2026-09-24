#!/usr/bin/env bash
# Détection de secrets dans les fichiers suivis par git (CI et poste de développement).
#   ./deploy/scripts/check-secrets.sh            → tout le dossier sbs-medigest
# Code de sortie ≠ 0 si un secret probable est trouvé. N'affiche que le fichier et la ligne,
# jamais la valeur. Les identifiants de DÉVELOPPEMENT connus (base locale, tests) sont autorisés.
set -uo pipefail
cd "$(dirname "$0")/../.."
FAIL=0
hit() { echo "  ✖ $1 : $2"; FAIL=$((FAIL+1)); }

mapfile -t FILES < <(git ls-files --cached --others --exclude-standard -- . ':!:**/package-lock.json' ':!:**/*.png' ':!:**/*.ico' ':!:**/*.pdf')

# 1. Fichiers qui ne doivent jamais être versionnés
for f in "${FILES[@]}"; do
  case "$f" in
    .env|*/.env|*.pem|*.key|*.p12|*.pfx|secrets/*|*/secrets/*|*rclone.conf|*rclone.env) hit "$f" "fichier de secret versionné";;
  esac
done

# 2. Motifs de secrets dans le contenu
PATTERNS=(
  '-----BEGIN ([A-Z]+ )?PRIVATE KEY-----'                          # clé privée
  'AKIA[0-9A-Z]{16}'                                               # clé d'accès AWS
  'gh[pousr]_[A-Za-z0-9]{36,}'                                     # jeton GitHub
  'xox[baprs]-[A-Za-z0-9-]{10,}'                                   # jeton Slack
  '(DATA_ENCRYPTION_KEY|AUDIT_HMAC_KEY|_PASSWORD|SECRET_ACCESS_KEY|BACKUP_KEY_PASSPHRASE)[[:space:]]*[:=][[:space:]]*["'"'"']?[A-Za-z0-9+/_=-]{16,}'
  'postgres(ql)?://[^:/[:space:]]+:[^@[:space:]]{6,}@'             # mot de passe dans une URL de base
)
# Valeurs de développement / test publiques et variables d'interpolation (pas des secrets)
ALLOW='check-secrets: exemple|sbs:sbs@|sbs_app:sbs_app@|sbs_backup:sbs_backup@|\$\{[A-Z_]+\}|<[a-z ]+>|…|x{6,}|REMPLACER|AdminTest2026|:mdp@|:<tmp>|\$\{?[A-Z_]*PASSWORD'
for f in "${FILES[@]}"; do
  [[ -f "$f" ]] || continue
  for p in "${PATTERNS[@]}"; do
    while IFS=: read -r line _; do
      [[ -n "$line" ]] || continue
      content=$(sed -n "${line}p" "$f")
      [[ "$content" =~ $ALLOW ]] && continue
      echo "$content" | grep -Eq "$ALLOW" && continue
      hit "$f:$line" "secret probable (motif ${p:0:30}…)"
    done < <(grep -nE -- "$p" "$f" 2>/dev/null)
  done
done

if [[ $FAIL -eq 0 ]]; then echo "  ✔ aucun secret détecté (${#FILES[@]} fichiers)"; fi
exit $((FAIL > 0))
