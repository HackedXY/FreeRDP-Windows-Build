#!/usr/bin/env bash
# Vérifications APRÈS la mise en service, depuis n'importe quel poste :
#   ./deploy/scripts/verify.sh sbs.mondomaine.gn
# Options (répétition locale uniquement) : CURL_CA=<certificat racine> CURL_RESOLVE=<domaine:443:ip>
set -uo pipefail
D="${1:?Usage : $0 <domaine>}"
FAIL=0
ok() { echo "  ✔ $*"; }; ko() { echo "  ✖ $*"; FAIL=$((FAIL+1)); }
C=(curl -s -m 10); [[ -n "${CURL_CA:-}" ]] && C+=(--cacert "$CURL_CA")
[[ -n "${CURL_RESOLVE:-}" ]] && C+=(--resolve "$CURL_RESOLVE" --resolve "${CURL_RESOLVE/:443:/:80:}")
H() { "${C[@]}" -o /dev/null -D - "$@" | tr -d '\r'; }

echo "== HTTPS et certificat"
code=$("${C[@]}" -o /dev/null -w '%{http_code}' "https://$D/api/health"); [[ "$code" == 200 ]] && ok "https://$D/api/health → 200 (certificat valide)" || ko "https://$D/api/health → $code (certificat ou service en défaut)"
"${C[@]}" "https://$D/api/health" | grep -q '"status":"ok"' && ok "API et base de données opérationnelles" || ko "santé de l'API/base en défaut"
redir=$(H "http://$D/" | awk 'NR==1{print $2}'); [[ "$redir" =~ ^30[178]$ ]] && ok "HTTP redirigé vers HTTPS ($redir)" || ko "HTTP non redirigé (code $redir)"
if [[ -z "${CURL_CA:-}" ]]; then
  exp=$(echo | openssl s_client -servername "$D" -connect "$D:443" 2>/dev/null | openssl x509 -noout -enddate 2>/dev/null | cut -d= -f2)
  [[ -n "$exp" ]] && ok "certificat valide jusqu'au $exp" || ko "certificat illisible"
fi

echo "== En-têtes de sécurité"
HD=$(H "https://$D/")
for h in "strict-transport-security" "content-security-policy" "x-content-type-options: nosniff" "x-frame-options" "referrer-policy"; do
  echo "$HD" | grep -qi "^$h" && ok "$h" || ko "en-tête absent : $h"
done
echo "$HD" | grep -qi "^server:" && ko "en-tête Server exposé" || ok "en-tête Server masqué"
H "https://$D/api/health" | grep -qi "^cache-control: no-store" && ok "réponses API non mises en cache (no-store)" || ko "Cache-Control no-store absent sur l'API"

echo "== Application"
"${C[@]}" "https://$D/" | grep -q '<div id="root">' && ok "interface servie" || ko "interface non servie"
code=$("${C[@]}" -o /dev/null -w '%{http_code}' "https://$D/api/patients"); [[ "$code" == 401 ]] && ok "API protégée sans session (401)" || ko "API accessible sans session ($code)"
code=$("${C[@]}" -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' -d '{}' "https://$D/api/auth/login"); [[ "$code" == 403 ]] && ok "protection CSRF active (403 sans en-tête)" || ko "protection CSRF : code $code"
ws() { "${C[@]}" --http1.1 -o /dev/null -w '%{http_code}' -H 'Connection: Upgrade' -H 'Upgrade: websocket' -H 'Sec-WebSocket-Version: 13' \
  -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' -H "Origin: $1" "https://$D/socket.io/?EIO=4&transport=websocket" --max-time 3; }
[[ "$(ws "https://$D")" == 101 ]] && ok "WebSocket temps réel via Caddy (101)" || ko "WebSocket temps réel en échec"
[[ "$(ws "https://site-malveillant.example")" != 101 ]] && ok "WebSocket refusé depuis une origine étrangère" || ko "WebSocket accepté depuis une origine étrangère"

echo "== Ports internes non exposés"
HOST=$(getent ahostsv4 "$D" | awk '{print $1; exit}'); [[ -n "${CURL_RESOLVE:-}" ]] && HOST="${CURL_RESOLVE##*:}"
for p in 5432 4000 5173; do
  if timeout 3 bash -c "</dev/tcp/$HOST/$p" 2>/dev/null; then ko "port $p joignable sur $HOST"; else ok "port $p fermé"; fi
done

echo
echo "Résultat : $FAIL échec(s)."
[[ $FAIL -eq 0 ]]
