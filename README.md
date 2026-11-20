# MT5 Monitor - Cloud Trading Dashboard

**Real-time MT5 account monitoring with web dashboard, push notifications, and multi-account support.**

---

## 🎯 Features

| Feature | Description |
|---------|-------------|
| **Multi-Account** | Add unlimited MT5 accounts (demo/live) |
| **Real-time Positions** | Open trades with P/L, pips, swap, SL/TP |
| **Trade History** | Complete deal history with filters & stats |
| **Account Analytics** | Balance, equity, margin level, equity curve |
| **Push Notifications** | Browser alerts for new/closed positions |
| **Secure** | Encrypted credentials, JWT auth, HTTPS only |
| **Self-Hosted** | Runs on your Oracle Cloud VPS (free tier eligible) |

---

## 🏗️ Architecture

```
┌─────────────┐     HTTPS/JSON      ┌──────────────┐     WebSocket     ┌─────────────┐
│  MT5 on VPS │ ──────────────────▶ │  Backend API │ ◀────────────────▶ │  Browser    │
│  (Account   │   Push: positions,  │  (Node.js +  │   Real-time UI    │  Dashboard  │
│   Monitor)  │   orders, history   │   SQLite)    │   updates         │             │
└─────────────┘                     └──────────────┘                   └─────────────┘
```

**Key Principle**: MT5 EA **pushes** data to API → Dashboard **receives** via WebSocket.  
Credentials never leave your VPS.

---

## 🚀 Quick Deploy (Oracle Cloud Free Tier)

### 1. Create VPS
- Oracle Cloud → Create VM → **VM.Standard.A1.Flex** (4 ARM CPUs, 24GB RAM) - **Always Free**
- Ubuntu 22.04, SSH key, public IP

### 2. Run Setup Script
```bash
# On your VPS
git clone https://github.com/your-repo/mt5-monitor.git
cd mt5-monitor/deploy
chmod +x setup-vps.sh
./setup-vps.sh
```

**Script will:**
- Install Docker, Nginx, Certbot, Fail2Ban
- Generate secure secrets (JWT, encryption keys)
- Obtain Let's Encrypt SSL certificate
- Build & start containers
- Configure auto-start on reboot

### 3. Access Dashboard
Open `https://your-domain.com` → Register → Add MT5 account → Get API Key

---

## 📦 Project Structure

```
mt5-monitor/
├── mql5/
│   └── Experts/
│       └── AccountMonitor.mq5      # MT5 Bridge EA (pushes data to API)
├── server/
│   ├── index.js                    # Express + WebSocket server
│   ├── database.js                 # SQLite + encryption
│   ├── auth.js                     # JWT auth, account management
│   ├── routes/
│   │   ├── auth.js                 # Login/register
│   │   ├── accounts.js             # CRUD MT5 accounts
│   │   ├── positions.js            # Position data
│   │   ├── history.js              # Trade history & stats
│   │   ├── webhook.js              # EA data ingestion
│   │   └── notifications.js        # User notifications
│   ├── package.json
│   └── .env.example
├── client/
│   └── index.html                  # Single-file dashboard (no build)
├── deploy/
│   ├── Dockerfile
│   ├── docker-compose.yml
│   ├── nginx.conf
│   └── setup-vps.sh                # One-command VPS setup
└── README.md
```

---

## 🔧 MT5 EA Configuration

### 1. Install EA
- Copy `mql5/Experts/AccountMonitor.mq5` to MT5 `MQL5/Experts/`
- Compile in MetaEditor (F7)

### 2. Configure Inputs
| Parameter | Value | Description |
|-----------|-------|-------------|
| `InpApiBaseUrl` | `https://your-domain.com/api` | Your deployed API URL |
| `InpApiKey` | `<from dashboard>` | API Key from Accounts page |
| `InpPushInterval` | `5` | Seconds between pushes |
| `InpPushPositions` | `true` | Push open positions |
| `InpPushOrders` | `true` | Push pending orders |
| `InpPushHistory` | `true` | Push deal history |
| `InpSymbolFilter` | `*` | `*` or `EURUSD,GBPUSD` |
| `InpHistoryDays` | `30` | Initial history depth |

### 3. Run EA
- Attach to any chart (e.g., EURUSD H1)
- Enable "Allow WebRequest for URL" → add your domain
- Check Experts log for "AccountMonitor initialized" + "POST /positions/sync OK"

---

## 🔐 Security Details

| Layer | Implementation |
|-------|----------------|
| **Transport** | TLS 1.2+ (Let's Encrypt via Nginx) |
| **API Auth** | JWT (access tokens, 7-day expiry) |
| **EA Auth** | API Key (SHA-256 hashed in DB) |
| **MT5 Credentials** | AES-256-CBC encrypted in SQLite |
| **Passwords** | bcrypt (cost 10) |
| **Rate Limiting** | 100 req/s general, 10/min auth |
| **Firewall** | UFW (only 22, 80, 443 open) |
| **Intrusion** | Fail2Ban (SSH, Nginx) |

---

## 📊 Dashboard Guide

### Accounts Page
- **Add Account**: Name, Login, Server, Password (encrypted)
- **API Keys**: Generate keys for EA (copy once!)
- **Status**: Last sync time, active/inactive

### Positions Tab
- Real-time table: Symbol, Type, Volume, Open/Current, SL/TP, Swap, Profit, Pips
- Color-coded: Green=Buy/Profit, Red=Sell/Loss
- Auto-refreshes via WebSocket

### History Tab
- Filterable: Date range, Symbol, Type
- Stats: Win rate, profit factor, equity curve
- Export via browser dev tools → JSON

### Notifications
- Bell icon shows unread count
- Types: Position opened/closed, Margin warning
- Browser push notifications (allow when prompted)

---

## 🛠️ Development

### Local Development
```bash
cd server
cp .env.example .env
# Edit .env with local values
npm install
npm run dev          # Starts with nodemon on port 3000
```

### Database
```bash
npm run init-db      # Initialize SQLite schema
```

### Client
Just open `client/index.html` in browser (served by Nginx in prod).

---

## 📡 API Reference

### Authentication
```
POST   /api/auth/register     {email, password}
POST   /api/auth/login        {email, password} → {user, token}
GET    /api/auth/me           (Bearer token)
POST   /api/auth/refresh      (Bearer token)
```

### Accounts
```
GET    /api/accounts                    List accounts
POST   /api/accounts                    {name, login, server, password}
GET    /api/accounts/:id                Get account
PUT    /api/accounts/:id                {name}
DELETE /api/accounts/:id                Soft delete
GET    /api/accounts/:id/credentials    Decrypted (owner only)
POST   /api/accounts/:id/api-keys       Generate EA API key
GET    /api/accounts/:id/api-keys       List keys
DELETE /api/accounts/:id/api-keys/:keyId Revoke key
```

### Positions & History
```
GET    /api/positions/:accountId              Open positions
GET    /api/positions/:accountId/history      Closed positions
GET    /api/positions/:accountId/summary      Stats
GET    /api/history/:accountId                Deals (filters: limit, offset, from, to, symbol, type)
GET    /api/history/:accountId/stats          Performance stats
GET    /api/history/:accountId/equity-curve   Equity curve data
```

### Webhook (EA → API)
```
POST   /api/webhook/account     Account snapshot
POST   /api/webhook/positions   Position sync
POST   /api/webhook/orders      Orders sync
POST   /api/webhook/history     Deal history sync
GET    /api/webhook/ping        Health check
```

### Notifications
```
GET    /api/notifications            List (unread filter)
GET    /api/notifications/unread-count
PUT    /api/notifications/:id/read
PUT    /api/notifications/read-all
DELETE /api/notifications/:id
```

### WebSocket
```
Connect: wss://domain/ws?token=<JWT>
Messages:
  {type: "connected", userId}
  {type: "notification", data: {...}}
  {type: "position_update", accountId}
  {type: "account_update", accountId}
```

---

## 🐳 Docker Commands

```bash
cd deploy

# Start
docker-compose up -d

# Logs
docker-compose logs -f api
docker-compose logs -f nginx

# Rebuild
docker-compose build --no-cache && docker-compose up -d

# Stop
docker-compose down

# Database backup
docker-compose exec api cp /app/data/mt5monitor.db /app/data/backup_$(date +%F).db

# Shell into API
docker-compose exec api sh
```

---

## 🔄 Updating

```bash
cd /opt/mt5-monitor
git pull
cd deploy
docker-compose build --no-cache
docker-compose up -d
```

---

## 🆘 Troubleshooting

| Issue | Solution |
|-------|----------|
| EA "WebRequest failed" | Check "Allow WebRequest" in EA settings → add your domain |
| "Invalid API key" | Regenerate key in dashboard → update EA input |
| Dashboard not loading | Check Nginx logs: `docker-compose logs nginx` |
| WS not connecting | Verify `/ws` path in nginx.conf, check browser console |
| SSL cert expired | `certbot renew --nginx` |
| DB locked | Restart API: `docker-compose restart api` |
| High memory | Reduce `InpHistoryDays`, increase swap |

---

## 📄 License

MIT License - Free for personal and commercial use.

---

## 🙏 Credits

- Built with Node.js, Express, SQLite, WebSocket
- Dashboard: Vanilla JS, CSS Variables
- Deployment: Docker, Nginx, Certbot, Fail2Ban
- MT5 Integration: WinHTTP (MQL5)

---

**Happy Trading!** 📈🚀