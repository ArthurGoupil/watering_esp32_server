#!/usr/bin/env bash
#
# ============================================================================
# Script d'installation - Serveur arrosage ESP32 sur Oracle Cloud (VM Ubuntu)
# ============================================================================
#
# A executer UNE FOIS sur la VM fraichement creee, via SSH :
#   ssh ubuntu@<IP_PUBLIQUE_VM>
#   curl -fsSL https://raw.githubusercontent.com/ArthurGoupil/watering_esp32_server/main/deploy/setup.sh | bash
#
# Ce script :
#   1. installe Node.js
#   2. clone le repo GitHub watering_esp32_server
#   3. installe un service systemd qui lance le serveur au demarrage
#      et le relance automatiquement s'il plante
#   4. ouvre le port 3000 dans le pare-feu local (ufw / iptables)
#
# ============================================================================

set -euo pipefail

REPO_URL="https://github.com/ArthurGoupil/watering_esp32_server.git"
APP_DIR="/opt/watering_esp32_server"
PORT="3000"
SERVICE_NAME="watering-server"

echo "==> Mise a jour des paquets..."
sudo apt-get update -y

echo "==> Installation de Node.js (via NodeSource)..."
if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
node --version

echo "==> Recuperation du code (${REPO_URL})..."
if [ -d "$APP_DIR" ]; then
  sudo git -C "$APP_DIR" pull
else
  sudo git clone "$REPO_URL" "$APP_DIR"
fi

echo "==> Creation du service systemd (${SERVICE_NAME})..."
sudo tee /etc/systemd/system/${SERVICE_NAME}.service > /dev/null <<EOF
[Unit]
Description=Serveur de test arrosage ESP32
After=network.target

[Service]
Type=simple
Environment=PORT=${PORT}
WorkingDirectory=${APP_DIR}
ExecStart=/usr/bin/node index.js
Restart=always
RestartSec=5
User=root

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable ${SERVICE_NAME}
sudo systemctl restart ${SERVICE_NAME}

echo "==> Ouverture du port ${PORT} dans le pare-feu local (ufw)..."
if command -v ufw >/dev/null 2>&1; then
  sudo ufw allow ${PORT}/tcp || true
fi
# Regle iptables (utile car les images Oracle Cloud filtrent aussi via iptables)
sudo iptables -I INPUT -p tcp --dport ${PORT} -j ACCEPT || true
sudo netfilter-persistent save 2>/dev/null || true

echo ""
echo "=========================================================================="
echo " Termine !"
echo " Le serveur tourne sur le port ${PORT} (service systemd: ${SERVICE_NAME})"
echo ""
echo " Verifier le statut  : sudo systemctl status ${SERVICE_NAME}"
echo " Voir les logs live  : sudo journalctl -u ${SERVICE_NAME} -f"
echo ""
echo " N'oublie pas d'ouvrir aussi le port ${PORT} dans la 'Security List' /"
echo " 'Network Security Group' de ta VM depuis la console OCI (regle Ingress)."
echo "=========================================================================="
