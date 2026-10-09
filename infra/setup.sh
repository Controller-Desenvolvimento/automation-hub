#!/bin/bash
# Executar uma vez após criar a VM Oracle Cloud (Ubuntu 22.04 ARM)
# Uso: bash setup.sh
set -e

APP_DIR="/opt/automation-hub"
DB_USER="hub"
DB_PASS="hub_prod_$(openssl rand -hex 8)"
DB_NAME="hub"
REPO="https://github.com/Controller-Desenvolvimento/automation-hub.git"

echo "=============================="
echo " Automation Hub - Setup Oracle"
echo "=============================="

# ── Sistema ──────────────────────────────────────────────
echo "[1/8] Atualizando sistema..."
sudo apt update && sudo apt upgrade -y
sudo apt install -y curl git build-essential openssl iptables-persistent

# ── Node.js 20 ───────────────────────────────────────────
echo "[2/8] Instalando Node.js 20..."
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# ── Python 3 ─────────────────────────────────────────────
echo "[3/8] Instalando Python 3..."
sudo apt install -y python3 python3-pip python3-venv

# ── Dependências do Playwright / Chromium ────────────────
echo "[4/8] Instalando Chromium e dependências..."
sudo apt install -y \
  chromium-browser \
  libnss3 libnss3-tools libnspr4 \
  libatk1.0-0 libatk-bridge2.0-0 libcups2 \
  libdrm2 libxkbcommon0 libxcomposite1 \
  libxdamage1 libxfixes3 libxrandr2 \
  libgbm1 libasound2 libpango-1.0-0 \
  libpangocairo-1.0-0 libgtk-3-0 \
  fonts-liberation xdg-utils

# ── PostgreSQL 15 ─────────────────────────────────────────
echo "[5/8] Instalando PostgreSQL..."
sudo apt install -y postgresql postgresql-contrib

sudo systemctl start postgresql
sudo systemctl enable postgresql

# Salva a senha gerada para mostrar no final
echo "DB_PASS=$DB_PASS" > /tmp/db_credentials.txt

sudo -u postgres psql -c "CREATE USER $DB_USER WITH PASSWORD '$DB_PASS';" 2>/dev/null || true
sudo -u postgres psql -c "CREATE DATABASE $DB_NAME OWNER $DB_USER;" 2>/dev/null || true
sudo -u postgres psql -c "GRANT ALL PRIVILEGES ON DATABASE $DB_NAME TO $DB_USER;"

# ── Clonar repositório ────────────────────────────────────
echo "[6/8] Clonando repositório..."
sudo mkdir -p $APP_DIR
sudo chown ubuntu:ubuntu $APP_DIR
git clone $REPO $APP_DIR

# Criar diretório de dados (arquivos de execução)
mkdir -p $APP_DIR/apps/api/data

# ── Arquivo .env ──────────────────────────────────────────
VM_IP=$(curl -s ifconfig.me 2>/dev/null || echo "SEU_IP_AQUI")

cat > $APP_DIR/apps/api/.env << EOF
DATABASE_URL=postgresql://$DB_USER:$DB_PASS@localhost:5432/$DB_NAME?schema=public
RUNNER_MAX_CONCURRENCY=2
RUNNER_MEMORY_THRESHOLD_PERCENT=85
ALLOWED_ORIGIN=http://$VM_IP:3000
PORT=3000
EOF

echo "Arquivo .env criado em $APP_DIR/apps/api/.env"

# ── Build ─────────────────────────────────────────────────
echo "[7/8] Instalando dependências e buildando..."
cd $APP_DIR/apps/web && npm install && npm run build
cd $APP_DIR/apps/api && npm install && npm run build && npx prisma generate
npx prisma migrate deploy

# ── Systemd service ───────────────────────────────────────
echo "[8/8] Configurando serviço systemd..."
sudo cp $APP_DIR/infra/automation-hub.service /etc/systemd/system/
sudo cp $APP_DIR/infra/sudoers-automation-hub /etc/sudoers.d/automation-hub
sudo chmod 440 /etc/sudoers.d/automation-hub
sudo systemctl daemon-reload
sudo systemctl enable automation-hub
sudo systemctl start automation-hub

# ── Firewall (porta 3000) ─────────────────────────────────
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 3000 -j ACCEPT
sudo netfilter-persistent save 2>/dev/null || sudo sh -c "iptables-save > /etc/iptables/rules.v4"

echo ""
echo "=============================="
echo " Setup concluído!"
echo "=============================="
echo ""
echo " URL de acesso: http://$VM_IP:3000"
echo ""
echo " Credenciais do banco:"
cat /tmp/db_credentials.txt
echo ""
echo " IMPORTANTE: Guarde a senha do banco acima!"
echo " Ela está também em: $APP_DIR/apps/api/.env"
echo ""
echo " PRÓXIMO PASSO:"
echo " No console Oracle Cloud, abra a porta 3000:"
echo " VCN → Security List → Add Ingress Rule"
echo " Source CIDR: 0.0.0.0/0 | Protocol: TCP | Port: 3000"
echo ""
