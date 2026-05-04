# Architecture

## System Overview

The Eurus server is a single Node.js process that multiplexes HTTP and WebSocket traffic on the same port. This design eliminates the need for a separate API gateway or reverse proxy for internal communication — both transports share the same authentication layer, in-memory state, and database connection pool.

```
                    ┌─────────────────────────────────────────┐
                    │         HTTP Server (Node.js)            │
                    │         Single process, single port       │
                    └──────────────────┬──────────────────────┘
                                       │
                    ┌──────────────────┼──────────────────┐
                    │                  │                  │
              ┌─────▼──────┐   ┌──────▼──────┐   ┌──────▼───────┐
              │  Express    │   │  WebSocket  │   │  Graceful    │
              │  REST API   │   │  Server     │   │  Shutdown    │
              │  (api.ts)   │   │  (server.ts)│   │  (SIGINT)    │
              └─────┬──────┘   └──────┬──────┘   └──────────────┘
                    │                 │
    ┌───────────────┼─────────────────┼───────────────────────┐
    │               │                 │                       │
    ▼               ▼                 ▼                       ▼
┌────────┐   ┌────────────┐   ┌───────────────┐   ┌──────────────────┐
│ Auth   │   │ Room Ops   │   │ Message       │   │ Voice Manager    │
│ Routes │   │ (CRUD,     │   │ Handler       │   │ (RoomVoiceManager│
│        │   │  invites,  │   │ (broadcast,   │   │  per-room SFU)   │
│        │   │  DMs)      │   │  persist)     │   │                  │
└────────┘   └────────────┘   └───────────────┘   └──────────────────┘
    │               │                 │                       │
    └───────────────┼─────────────────┼───────────────────────┘
                    │                 │
              ┌─────▼─────────────────▼─────┐
              │        Prisma Client         │
              │        (database.ts)         │
              └───────────────┬─────────────┘
                              │
                    ┌─────────▼─────────┐
                    │    PostgreSQL      │
                    └───────────────────┘
```

## Core Design Decisions

### 1. Shared HTTP + WebSocket Server

Both Express and the WebSocket server listen on the same `http.Server` instance. This is not two servers on different ports — it's one HTTP server where Express handles regular HTTP requests and the WebSocket server intercepts upgrade requests to `/ws`.

**Why:** Simplifies deployment (one port, one process), shares authentication state, and avoids CORS issues between API and WebSocket. The HTTP server handles auth and historical queries; the WebSocket handles real-time events.

### 2. In-Memory State with Database as Source of Truth

The server maintains two in-memory maps:
- `connectedUsers: Map<WebSocket, ConnectedUser>` — active WebSocket connections
- `activeRooms: Map<string, ActiveRoom>` — rooms with at least one connected user

These are rebuilt on server restart from the database. The database is the authoritative store for users, rooms, messages, invites, and room keys.

**Why:** WebSocket operations require O(1) lookups for message routing and room membership. Querying the database on every message would add unacceptable latency. The in-memory cache is invalidated on every mutation and rebuilt from the database on join operations.

### 3. End-to-End Encryption

All chat messages are encrypted client-side with AES-256-GCM before transmission. The server stores only ciphertext. Room keys are generated server-side and distributed to members via the `RoomKey` table, encrypted per-user.

**Why:** The server cannot read message content, even under subpoena or if compromised. This is a fundamental privacy guarantee, not an optional feature. The server's role is message routing and key distribution, not content access.

### 4. Opus-over-WebSocket Voice (No WebRTC)

Voice chat uses the existing authenticated WebSocket connection to transport base64-encoded Opus audio frames. The server decodes each user's audio, mixes it per-target (excluding the sender), re-encodes to Opus, and sends it back. There is no WebRTC, no ICE, no STUN, no TURN.

**Why:** WebRTC introduces massive complexity (ICE negotiation, NAT traversal, PeerConnection lifecycle, renegotiation on participant changes) for a tool designed for 2-5 participants per room. Opus-over-WebSocket:
- Works behind every NAT (TCP over existing TLS connection)
- Requires no additional ports or infrastructure
- Is fully debuggable with existing logging
- Has imperceptible latency difference for small groups
- Eliminates an entire class of connection failures

This is the same architectural choice Mumble made for its TCP mode, and it is proven at scale.

### 5. Soft Deletes

Rooms are soft-deleted via `deletedAt` timestamp rather than hard-deleted. Messages and room keys are preserved.

**Why:** Preserves audit trails, allows room name recycling without collisions, and prevents accidental data loss. Hard deletes are reserved for explicit data removal requests.

### 6. SSH Key Authentication

Users authenticate with SSH keys (Ed25519 or RSA) via a challenge-response protocol. No passwords. No OAuth. No email verification.

**Why:** Developers already have SSH keys. The challenge-response flow proves key ownership without transmitting private key material. It eliminates password reuse attacks, brute-force attacks, and email-based account recovery vulnerabilities.

## Component Responsibilities

### `server.ts` (Entry Point)
- Creates the HTTP server, Express app, and WebSocket server
- Routes WebSocket messages by `type` field to handler functions
- Manages `connectedUsers` and `activeRooms` maps
- Handles graceful shutdown (SIGINT/SIGTERM)

### `auth.ts` (Authentication)
- Registration: stores public keys, generates JWTs
- Challenge-response: generates random challenges, verifies signatures
- JWT validation for WebSocket connections
- Dev-mode simple login (disabled in production)

### `api.ts` (REST API)
- Auth endpoints: `/api/auth/register`, `/api/auth/challenge`, `/api/auth/verify`, `/api/auth/login`, `/api/auth/exists/:username`, `/api/auth/refresh`
- Room endpoints: `/api/rooms`, `/api/rooms/:roomId/messages`
- Health check: `/health`

### `voice.ts` (Voice SFU)
- `RoomVoiceManager`: one instance per active voice session
- Decodes Opus frames to PCM, mixes per-target, re-encodes
- 20ms mix loop with silence suppression
- Lifecycle management (create on join, destroy on empty)

### `database.ts` (Prisma Client)
- Singleton Prisma client with environment-aware logging
- Graceful disconnect on shutdown

### `storage.ts` (Object Storage)
- Uploads encrypted images to Oracle Object Storage (S3-compatible)
- Generates public URLs for image messages

### `images.ts` (Image Processing)
- Resizes, compresses, and generates thumbnails via Sharp
- Used for image message previews (not for encrypted content)
