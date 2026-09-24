#!/usr/bin/env bash
# Préparation d'un VPS Ubuntu 22.04 / 24.04 (à lancer une fois, en root : sudo bash setup-vps.sh).
#  - mises à jour de sécurité automatiques, fuseau Africa/Conakry, swap si < 4 Go de RAM
#  - Docker Engine + Compose (dépôt officiel Docker)
#  - pare-feu ufw : SEULS 22 (SSH), 80 et 443 ouverts ; fail2ban pour SSH
#  - utilisateur « sbs » dédié à l'exploitation
#  - option --harden-ssh : désactive la connexion root et par mot de passe (UNIQUEMENT si une clé SSH est déjà installée)
set -euo pipefail
[[ $EUID -eq 0 ]] || { echo "À lancer en root (sudo)." >&2; exit 1; }
. /etc/os-release; [[ "$ID" == ubuntu ]] || { echo "Script prévu pour Ubuntu (détecté : $ID)." >&2; exit 1; }
HARDEN_SSH=false; [[ "${1:-}" == "--harden-ssh" ]] && HARDEN_SSH=true
export DEBIAN_FRONTEND=noninteractive

echo "== Paquets et mises à jour automatiques"
apt-get update -q
apt-get upgrade -yq
apt-get install -yq ca-certificates curl gnupg git ufw fail2ban unattended-upgrades openssl
dpkg-reconfigure -f noninteractive unattended-upgrades
timedatectl set-timezone Africa/Conakry || true

echo "== Swap (si mémoire < 4 Go)"
if [[ $(awk '/MemTotal/ {print $2}' /proc/meminfo) -lt 4000000 && ! -f /swapfile ]]; then
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

echo "== Docker"
if ! command -v docker >/dev/null; then
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu ${VERSION_CODENAME} stable" > /etc/apt/sources.list.d/docker.list
  apt-get update -q
  apt-get install -yq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi
systemctl enable --now docker

echo "== Utilisateur d'exploitation « sbs »"
id sbs >/dev/null 2>&1 || adduser --disabled-password --gecos "Exploitation SBS" sbs
usermod -aG docker sbs   # NB : le groupe docker équivaut à des droits root sur la machine

echo "== Pare-feu"
ufw default deny incoming
ufw default allow outgoing
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable
# PostgreSQL (5432) et l'API (4000) ne sont jamais publiés par docker-compose.yml : seul Caddy (80/443) l'est.
systemctl enable --now fail2ban

if $HARDEN_SSH; then
  echo "== Durcissement SSH"
  if ls /root/.ssh/authorized_keys /home/*/.ssh/authorized_keys 2>/dev/null | xargs -r grep -l "ssh-" >/dev/null; then
    cat > /etc/ssh/sshd_config.d/90-sbs.conf <<'CONF'
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin prohibit-password
CONF
    systemctl reload ssh || systemctl reload sshd
    echo "Connexion SSH par mot de passe désactivée (clé requise)."
  else
    echo "⚠ Aucune clé SSH installée : durcissement SSH NON appliqué pour éviter de vous enfermer dehors."
  fi
fi

echo
echo "✔ Serveur prêt. Étapes suivantes (en tant que « sbs ») : cloner le dépôt, generate-secrets.sh, preflight.sh."
