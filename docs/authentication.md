# Authentication

Eurus uses SSH key-based challenge-response authentication. There are no passwords, no OAuth providers, and no email verification. Users prove their identity by signing a server-issued cryptographic challenge with their SSH private key.

## Key Types

The server supports two key algorithms:

- **Ed25519** — Modern, fast, 64-byte signatures. Recommended.
- **RSA** — Legacy support, 2048+ bit keys, SHA-256 signatures.

The key type is specified during registration and stored in the database. The server uses `tweetnacl` for Ed25519 verification and `node-forge` for RSA verification.

## Registration Flow

### 1. Client Sends Registration Request

```
POST /api/auth/register
Content-Type: application/json

{
  "username": "alice",
  "publicKey": "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI...",
  "keyType": "ed25519"
}
```

### 2. Server Validates and Stores

- Username must be 3-32 characters, alphanumeric plus underscore and hyphen
- Public key is stored in the appropriate column (`publicKeyEd25519` or `publicKeyRsa`)
- A JWT token is generated with a 90-day expiry
- The user record is created with `lastSeen` set to now

### 3. Server Responds with JWT

```json
{
  "userId": "550e8400-e29b-41d4-a716-446655440000",
  "username": "alice",
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
}
```

The client stores this token locally (default: `~/.config/eurus/token`).

## Challenge-Response Login Flow

### 1. Client Requests a Challenge

```
POST /api/auth/challenge
Content-Type: application/json

{
  "username": "alice"
}
```

The server generates a 32-byte random challenge, stores it in-memory with a timestamp, and returns it:

```json
{
  "challenge": "a3f8c9d2e1b4..."
}
```

Challenges expire after 5 minutes.

### 2. Client Signs the Challenge

The client uses the user's SSH private key to sign the challenge bytes. This happens locally — the private key never leaves the client machine. The signing can occur via:
- **ssh-agent** — Preferred. The client connects to the agent socket and requests a signature.
- **Direct file access** — Falls back to loading the private key from `~/.ssh/`. Encrypted keys require a passphrase.

### 3. Client Submits the Signature

```
POST /api/auth/verify
Content-Type: application/json

{
  "username": "alice",
  "signature": "3045022100a1b2c3d4...",
  "publicKey": "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI..."
}
```

### 4. Server Verifies

The server performs three checks in order:

1. **Challenge exists and is not expired** — The challenge must have been issued within the last 5 minutes.
2. **Public key matches** — The submitted public key must match the stored key for that username.
3. **Signature is valid** — The signature must verify against the challenge using the stored public key.

If all checks pass, a new JWT is generated and `lastSeen` is updated.

## JWT Token Details

- **Algorithm:** HS256 (HMAC-SHA256)
- **Secret:** `JWT_SECRET` environment variable (defaults to `'dev-secret-change-in-production'`)
- **Payload:** `{ userId, username, iat, exp }`
- **Expiry:** 90 days from issuance
- **Usage:** Passed as a query parameter on WebSocket connection (`ws://host:8081/ws?token=<jwt>`)

### Token Refresh

If a token expires within 24 hours, the client can refresh it:

```
POST /api/auth/refresh
Authorization: Bearer <current-token>
```

The server validates the current token and issues a new one with a fresh 90-day expiry.

## WebSocket Authentication

When a client connects to the WebSocket endpoint, it includes the JWT as a query parameter:

```
ws://host:8081/ws?token=eyJhbGciOiJIUzI1NiIs...
```

The server validates the token synchronously during the connection handshake:

- **Valid token:** Creates an authenticated `ConnectedUser` with the decoded `userId` and `username`.
- **Invalid or missing token:** Creates a guest user with a random name (`Guest_XXXXX`). Guest users can join public rooms but have limited capabilities.

## Development Mode

In development mode (`NODE_ENV !== 'production'`), a simplified login endpoint is available:

```
POST /api/auth/login
Content-Type: application/json

{
  "username": "alice"
}
```

This endpoint auto-creates the user if they don't exist and returns a JWT without any cryptographic verification. It is **completely disabled in production**.

## Security Properties

- **No password storage** — No password hashes, no bcrypt, no credential database to leak.
- **No private key transmission** — The private key never leaves the client. Only signatures travel over the network.
- **Challenge freshness** — Random 32-byte challenges with 5-minute expiry prevent replay attacks.
- **Key binding** — The public key is verified against the stored key, preventing key substitution.
- **JWT signing** — Server-side secret prevents token forgery. The secret must be kept secure in production.
