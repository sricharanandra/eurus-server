# Deployment

The Eurus server runs as a systemd service on an Ubuntu VPS. This document covers the complete deployment process, environment configuration, and troubleshooting.

## Server Requirements

- **OS:** Ubuntu 24.04 LTS (or later)
- **Node.js:** 20.x
- **Database:** PostgreSQL 15+
- **Build tools:** `build-essential`, `libopus-dev` (for `@discordjs/opus` native compilation)
- **Memory:** 250MB RAM high watermark (configured in systemd unit)

## Initial Setup

### 1. Install System Dependencies

```bash
sudo apt-get update
sudo apt-get install -y build-essential libopus-dev
```

These are required for compiling the `@discordjs/opus` native addon. Without `build-essential` (which provides `make`, `gcc`, `g++`) and `libopus-dev` (Opus headers and library), `npm install` will fail.

### 2. Clone and Install

```bash
cd /opt/eurus
git clone <repository-url> .
npm install
```

### 3. Configure Environment

Create a `.env` file in the project root:

```env
# Server
NODE_ENV=production
PORT=8081
HOST=127.0.0.1

# Database
DATABASE_URL=postgresql://<user>:<password>@localhost:5432/eurus

# JWT
JWT_SECRET=<generate-a-strong-random-string>

# Object Storage (optional, for image messages)
S3_ENDPOINT=
S3_REGION=
S3_BUCKET=
S3_ACCESS_KEY=
S3_SECRET_KEY=
```

**Critical:** The `JWT_SECRET` must be a strong random string. All tokens are signed with this secret. If it changes, all existing tokens become invalid and every user must re-authenticate.

### 4. Set Up Database

```bash
npx prisma generate
npx prisma migrate deploy
```

### 5. Create Systemd Service

Create `/etc/systemd/system/eurus.service`:

```ini
[Unit]
Description=Eurus WebSocket Server
After=network.target postgresql.service

[Service]
Type=simple
WorkingDirectory=/opt/eurus
ExecStart=/usr/bin/node dist/server.js
Restart=on-failure
RestartSec=5
MemoryHigh=250M
MemoryMax=300M

# Environment
EnvironmentFile=/opt/eurus/.env

# Security
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/opt/eurus

[Install]
WantedBy=multi-user.target
```

### 6. Enable and Start

```bash
sudo systemctl daemon-reload
sudo systemctl enable eurus
sudo systemctl start eurus
sudo systemctl status eurus
```

## Deployment Procedure

When server code changes are pushed to `main`:

```bash
# On the server
cd /opt/eurus
git pull
npm install          # Installs new/updated dependencies
npm run build        # Compiles TypeScript to dist/
sudo systemctl restart eurus
```

**One-liner:**

```bash
cd /opt/eurus && git pull && npm install && npm run build && sudo systemctl restart eurus
```

### If package.json Changed

If `package.json` was modified (new dependency, version bump), `npm install` must run before `npm run build`. The build step compiles TypeScript but does not install dependencies.

### If Prisma Schema Changed

If `prisma/schema.prisma` was modified, run migrations before restarting:

```bash
cd /opt/eurus && git pull && npm install && npx prisma migrate deploy && npm run build && sudo systemctl restart eurus
```

## Rollback

If a deployment causes issues:

```bash
cd /opt/eurus
git log --oneline -5          # Find the previous good commit
git reset --hard <commit-hash>
npm install
npm run build
sudo systemctl restart eurus
```

## Logs

### Systemd Journal

```bash
# View recent logs
sudo journalctl -u eurus --no-pager -n 100

# Follow live
sudo journalctl -u eurus -f
```

### Application Logs

The server writes structured logs to stdout, which systemd captures. Key log prefixes:

| Prefix | Meaning |
|---|---|
| `[STARTUP]` | Server initialization, environment info |
| `[WS]` | WebSocket connections, disconnections, message sending |
| `[AUTH]` | Authentication attempts, token validation |
| `[ROOM]` | Room joins, leaves, creation, deletion |
| `[MSG]` | Message sending, persistence |
| `[INVITE]` | Invite code generation and usage |
| `[VOICE]` | Voice session lifecycle, audio processing |

## Health Check

The server exposes a health endpoint:

```bash
curl http://127.0.0.1:8081/health
```

Response:

```json
{
  "status": "ok",
  "environment": "production",
  "uptime": 3600,
  "timestamp": "2026-04-01T12:00:00.000Z"
}
```

## Reverse Proxy

The server listens on `127.0.0.1:8081` by default. A reverse proxy (nginx, Caddy, etc.) should handle TLS termination and forward traffic:

### Nginx Example

```nginx
server {
    listen 443 ssl;
    server_name eurus.example.com;

    location /ws {
        proxy_pass http://127.0.0.1:8081;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "Upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }

    location / {
        proxy_pass http://127.0.0.1:8081;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

**Critical:** The `/ws` location must include the `Upgrade` and `Connection` headers for WebSocket to work. Without these, clients will fail to establish WebSocket connections.

## Troubleshooting

### `@discordjs/opus` fails to install

**Error:** `gyp ERR! stack Error: not found: make`

**Fix:** Install build tools: `sudo apt-get install -y build-essential libopus-dev`

### Server starts but clients can't connect

**Check:** Is the server listening on the correct interface?

```bash
ss -tlnp | grep 8081
```

If it shows `127.0.0.1:8081`, the reverse proxy must be configured. If it shows `0.0.0.0:8081`, the server is directly exposed (not recommended without TLS).

### Voice doesn't work but chat works

**Check server logs** for `[VOICE]` entries. Common issues:
- `@discordjs/opus` not compiled — reinstall with `npm rebuild @discordjs/opus`
- `RoomVoiceManager` not created — check that `join_voice` signal is being received
- No `[VOICE]` logs at all — the dependency may not be installed

### Database connection fails

**Check:** Is PostgreSQL running and is `DATABASE_URL` correct?

```bash
sudo systemctl status postgresql
npx prisma db execute --stdin < /dev/null  # Tests connection
```
