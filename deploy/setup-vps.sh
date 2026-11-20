#!/bin/bash
# ============================================================================
# MT5 Monitor - Oracle Cloud VPS One-Command Setup
# ============================================================================
# Run as: curl -sSL https://raw.githubusercontent.com/your-repo/mt5-monitor/main/deploy/setup-vps.sh | bash
# Or copy this file to your VPS and run: chmod +x setup-vps.sh && ./setup-vps.sh
# ============================================================================

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
REPO_URL="https://github.com/your-username/mt5-monitor.git"  # CHANGE THIS
PROJECT_DIR="/opt/mt5-monitor"
DOMAIN=""  # Will prompt
EMAIL=""   # Will prompt

echo -e "${BLUE}"
cat << "EOF"
╔═══════════════════════════════════════════════════════════════════╗
║     MT5 Monitor - Oracle Cloud VPS Setup                        ║
║     Automated deployment with Docker, Nginx, SSL                ║
╚═══════════════════════════════════════════════════════════════════╝
EOF
echo -e "${NC}"

# Check if running as root
if [[ $EUID -eq 0 ]]; then
   echo -e "${YELLOW}Running as root. Will create 'mt5monitor' user for security.${NC}"
fi

# Get domain and email
read -p "Enter your domain (e.g., monitor.yourdomain.com): " DOMAIN
if [[ -z "$DOMAIN" ]]; then
    echo -e "${RED}Domain is required!${NC}"
    exit 1
fi

read -p "Enter email for Let's Encrypt SSL: " EMAIL
if [[ -z "$EMAIL" ]]; then
    echo -e "${RED}Email is required for SSL certificates!${NC}"
    exit 1
fi

echo -e "\n${GREEN}Configuration:${NC}"
echo -e "  Domain: $DOMAIN"
echo -e "  Email:  $EMAIL"
echo -e "  Dir:    $PROJECT_DIR"
read -p "Continue? (y/N): " CONFIRM
if [[ ! "$CONFIRM" =~ ^[Yy]$ ]]; then
    echo "Aborted."
    exit 1
fi

# ============================================================================
# 1. SYSTEM UPDATE & DEPENDENCIES
# ============================================================================
echo -e "\n${BLUE}[1/8] Updating system & installing dependencies...${NC}"
apt-get update -qq
apt-get install -y -qq \
    curl wget git \
    docker.io docker-compose \
    nginx certbot python3-certbot-nginx \
    ufw fail2ban \
    htop net-tools

# Enable services
systemctl enable docker
systemctl start docker
systemctl enable nginx
systemctl start nginx

# Add user to docker group
usermod -aG docker $SUDO_USER 2>/dev/null || usermod -aG docker ubuntu 2>/dev/null || true

# ============================================================================
# 2. FIREWALL CONFIGURATION
# ============================================================================
echo -e "\n${BLUE}[2/8] Configuring firewall...${NC}"
ufw --force enable
ufw default deny incoming
ufw default allow outgoing
ufw allow ssh
ufw allow 80/tcp
ufw allow 443/tcp
ufw allow 3000/tcp  # For direct API access if needed
ufw reload

# ============================================================================
# 3. FAIL2BAN CONFIGURATION
# ============================================================================
echo -e "\n${BLUE}[3/8] Configuring Fail2Ban...${NC}"
cat > /etc/fail2ban/jail.local << 'EOF'
[DEFAULT]
bantime = 3600
findtime = 600
maxretry = 5
backend = systemd

[sshd]
enabled = true
port = ssh
filter = sshd
logpath = /var/log/auth.log
maxretry = 3

[nginx-http-auth]
enabled = true
filter = nginx-http-auth
port = http,https
logpath = /var/log/nginx/error.log

[nginx-limit-req]
enabled = true
filter = nginx-limit-req
port = http,https
logpath = /var/log/nginx/error.log
maxretry = 10
EOF
systemctl enable fail2ban
systemctl restart fail2ban

# ============================================================================
# 4. CLONE PROJECT
# ============================================================================
echo -e "\n${BLUE}[4/8] Cloning project...${NC}"
if [[ -d "$PROJECT_DIR" ]]; then
    echo "Project exists, pulling latest..."
    cd "$PROJECT_DIR"
    git pull
else
    git clone "$REPO_URL" "$PROJECT_DIR"
    cd "$PROJECT_DIR"
fi

# ============================================================================
# 5. GENERATE SECRETS & CONFIGURE ENV
# ============================================================================
echo -e "\n${BLUE}[5/8] Generating secrets & configuring environment...${NC}"

# Generate secure random strings
JWT_SECRET=$(openssl rand -hex 32)
ENCRYPTION_KEY=$(openssl rand -hex 16)  # 32 chars for aes-256-cbc

cat > "$PROJECT_DIR/server/.env" << EOF
# MT5 Monitor - Production Environment
# Generated on $(date)

NODE_ENV=production
PORT=3000
HOST=0.0.0.0
DB_PATH=/app/data/mt5monitor.db

# SECURITY - KEEP SECRET!
JWT_SECRET=$JWT_SECRET
ENCRYPTION_KEY=$ENCRYPTION_KEY

CORS_ORIGIN=https://$DOMAIN
EOF

chmod 600 "$PROJECT_DIR/server/.env"

# Update nginx config with domain
sed -i "s/your-domain.com/$DOMAIN/g" "$PROJECT_DIR/deploy/nginx.conf"

# ============================================================================
# 6. OBTAIN SSL CERTIFICATE
# ============================================================================
echo -e "\n${BLUE}[6/8] Obtaining SSL certificate from Let's Encrypt...${NC}"

# Stop nginx temporarily
systemctl stop nginx

# Get certificate
certbot certonly --standalone \
    --non-interactive \
    --agree-tos \
    --email "$EMAIL" \
    -d "$DOMAIN" \
    --preferred-challenges http

# Create renewal hook
cat > /etc/letsencrypt/renewal-hooks/deploy/nginx-reload.sh << 'EOF'
#!/bin/bash
systemctl reload nginx
EOF
chmod +x /etc/letsencrypt/renewal-hooks/deploy/nginx-reload.sh

# Start nginx
systemctl start nginx

# ============================================================================
# 7. DEPLOY WITH DOCKER COMPOSE
# ============================================================================
echo -e "\n${BLUE}[7/8] Building and starting containers...${NC}"
cd "$PROJECT_DIR/deploy"

# Create certbot directories
mkdir -p certbot/conf certbot/www

# Copy nginx config to where docker-compose expects it
cp nginx.conf ../nginx.conf 2>/dev/null || true

# Build and start
docker-compose down -v 2>/dev/null || true
docker-compose build --no-cache
docker-compose up -d

# Wait for health check
echo "Waiting for API to be healthy..."
for i in {1..30}; do
    if curl -sf http://localhost:3000/api/health >/dev/null 2>&1; then
        echo -e "${GREEN}API is healthy!${NC}"
        break
    fi
    sleep 2
done

# ============================================================================
# 8. FINAL CONFIGURATION
# ============================================================================
echo -e "\n${BLUE}[8/8] Final configuration...${NC}"

# Setup log rotation
cat > /etc/logrotate.d/mt5-monitor << 'EOF'
/opt/mt5-monitor/deploy/logs/*.log {
    daily
    rotate 14
    compress
    delaycompress
    missingok
    notifempty
    create 644 root root
}
EOF

# Create systemd service for auto-start
cat > /etc/systemd/system/mt5-monitor.service << EOF
[Unit]
Description=MT5 Monitor Docker Compose
Requires=docker.service
After=docker.service

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=$PROJECT_DIR/deploy
ExecStart=/usr/bin/docker-compose up -d
ExecStop=/usr/bin/docker-compose down
TimeoutStartSec=0

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable mt5-monitor

# ============================================================================
# SUMMARY
# ============================================================================
echo -e "\n${GREEN}╔══════════════════════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║  DEPLOYMENT COMPLETE!                                            ║${NC}"
echo -e "${GREEN}╚══════════════════════════════════════════════════════════════════╝${NC}"
echo -e "\n${BLUE}Dashboard:${NC} https://$DOMAIN"
echo -e "${BLUE}API Health:${NC} https://$DOMAIN/api/health"
echo -e "${BLUE}WebSocket:${NC} wss://$DOMAIN/ws"
echo -e "\n${YELLOW}Next Steps:${NC}"
echo -e "  1. Open https://$DOMAIN in browser"
echo -e "  2. Register an account"
echo -e "  3. Add MT5 account (login, server, password)"
echo -e "  4. Copy API Key from Accounts page"
echo -e "  5. Configure MT5 EA (AccountMonitor.mq5) with:"
echo -e "     - InpApiBaseUrl: https://$DOMAIN/api"
echo -e "     - InpApiKey: <your-api-key>"
echo -e "  6. Run EA on your VPS MT5 terminal"
echo -e "\n${BLUE}Project Directory:${NC} $PROJECT_DIR"
echo -e "${BLUE}Logs:${NC} docker-compose -f $PROJECT_DIR/deploy/docker-compose.yml logs -f"
echo -e "${BLUE}Restart:${NC} systemctl restart mt5-monitor"
echo -e "\n${GREEN}Happy monitoring! 📈${NC}"