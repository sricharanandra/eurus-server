# Eurus Server

Eurus is an end-to-end encrypted terminal chat application with real-time voice chat. This repository contains the WebSocket + HTTP API server that powers the platform.

## Quick Start

```bash
# Install dependencies
npm install

# Set up database
npx prisma generate
npx prisma migrate deploy

# Start development server
npm run dev

# Build for production
npm run build
npm start
```

## Architecture

The server runs a single Node.js process that serves both HTTP and WebSocket traffic on the same port:

- **Express REST API** — Authentication endpoints, room listing, message history with cursor pagination, health check.
- **WebSocket server** — Real-time messaging, room management, voice chat, typing indicators, invite generation.
- **PostgreSQL database** — Persistent storage for users, rooms, messages, invites, and room keys via Prisma ORM.
- **Opus-over-WebSocket SFU** — Server-side voice mixing: decode Opus frames from each participant, mix per-target (excluding self), re-encode, and broadcast back. No WebRTC, ICE, STUN, or TURN.

Messages are encrypted end-to-end with AES-256-GCM. The server stores only ciphertext and manages room key distribution — it never has access to plaintext content.

## Project Structure

```
src/
├── server.ts      # Main entry: WebSocket + HTTP server, all message handlers
├── types.ts       # TypeScript interfaces for all message payloads and server state
├── auth.ts        # SSH key-based authentication (Ed25519/RSA challenge-response)
├── api.ts         # Express REST API routes (auth, rooms, messages, health)
├── voice.ts       # RoomVoiceManager: Opus decode → mix → encode pipeline
├── database.ts    # Prisma client singleton
├── storage.ts     # Oracle Object Storage (S3-compatible) for encrypted images
└── images.ts      # Image processing via Sharp (resize, compress, thumbnails)
```

## Documentation

| Document | Description |
|----------|-------------|
| [Architecture](architecture.md) | System design, component diagram, design decisions |
| [Authentication](authentication.md) | SSH key auth, JWT, challenge-response flow |
| [Protocol](protocol.md) | Complete WebSocket message type reference |
| [Rooms](rooms.md) | Room lifecycle, invites, DMs, membership |
| [Voice](voice.md) | Opus-over-WebSocket SFU architecture |
| [Database](database.md) | Prisma schema, models, migrations |
| [Deployment](deployment.md) | VPS deployment, systemd, environment variables |

## Tech Stack

- **Runtime:** Node.js 20+
- **Language:** TypeScript
- **HTTP:** Express 5
- **WebSocket:** `ws`
- **Database:** PostgreSQL via Prisma 5
- **Voice:** `@discordjs/opus` (native Opus codec)
- **Storage:** Oracle Object Storage (S3-compatible SDK)
- **Auth:** `tweetnacl` (Ed25519), `node-forge` (RSA), `jsonwebtoken` (JWT)
