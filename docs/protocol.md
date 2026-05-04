# Protocol Reference

All real-time communication between the Eurus client and server occurs over a single WebSocket connection. Messages are JSON objects with a `type` discriminator and a `payload` field.

## Message Format

### Client → Server

```json
{
  "type": "messageType",
  "payload": { ... }
}
```

### Server → Client

```json
{
  "type": "messageType",
  "payload": { ... }
}
```

The `type` field is a camelCase string that determines how the payload is interpreted.

---

## Client → Server Messages (13 types)

### `joinRoom`

Join a room by ID or by name.

```json
{
  "type": "joinRoom",
  "payload": {
    "roomId": "550e8400-...",
    "roomName": "general"
  }
}
```

Either `roomId` or `roomName` must be provided. If both are provided, `roomId` takes precedence. On success, the server responds with `roomJoined`.

### `sendMessage`

Send an encrypted message to the current room.

```json
{
  "type": "sendMessage",
  "payload": {
    "roomId": "550e8400-...",
    "ciphertext": "a3f8c9d2e1b4...",
    "messageType": "text",
    "imageData": "base64-encoded-encrypted-image"
  }
}
```

- `ciphertext` — AES-256-GCM encrypted message content (hex-encoded, with nonce prepended).
- `messageType` — `"text"` or `"image"`.
- `imageData` — Base64-encoded encrypted image data (only for image messages).

The server persists the message to the database and broadcasts it to all room members as a `message` event.

### `createRoom`

Create a new chat room.

```json
{
  "type": "createRoom",
  "payload": {
    "name": "team-chat",
    "displayName": "#team-chat",
    "roomType": "public"
  }
}
```

- `name` — URL-safe identifier (e.g., `"team-chat"`). Must be unique.
- `displayName` — Human-readable name (e.g., `"#team-chat"`). Auto-generated from `name` if not provided.
- `roomType` — `"public"` (visible to all users) or `"private"` (invite-only).

The creator is automatically added as a member and receives the room's encryption key.

### `leaveRoom`

Leave the current room.

```json
{
  "type": "leaveRoom",
  "payload": {
    "roomId": "550e8400-..."
  }
}
```

Removes the user from the room's in-memory user list and broadcasts `userLeft` to remaining members.

### `listRooms`

Request a list of all available rooms.

```json
{
  "type": "listRooms",
  "payload": {}
}
```

The server responds with `roomsList` containing public rooms and private rooms the user is a member of.

### `typing`

Send a typing indicator to the current room.

```json
{
  "type": "typing",
  "payload": {
    "roomId": "550e8400-..."
  }
}
```

The server broadcasts `userTyping` to other room members. Clients should debounce these events (typically 2-3 seconds).

### `createInvite`

Generate a single-use invite code for a room.

```json
{
  "type": "createInvite",
  "payload": {
    "roomId": "550e8400-..."
  }
}
```

Creates an 8-character alphanumeric code with a 24-hour expiry. Responds with `inviteCreated`.

### `joinViaInvite`

Join a room using an invite code.

```json
{
  "type": "joinViaInvite",
  "payload": {
    "code": "aB3dE5gH"
  }
}
```

Validates the code (exists, not expired, not already used), adds the user to the room, marks the invite as used, and responds with `roomJoined`.

### `renameRoom`

Rename a room (owner only).

```json
{
  "type": "renameRoom",
  "payload": {
    "roomId": "550e8400-...",
    "newName": "new-name"
  }
}
```

Updates the room's `name` and auto-generates a new `displayName`. Broadcasts `roomRenamed`.

### `deleteRoom`

Soft-delete a room (owner only).

```json
{
  "type": "deleteRoom",
  "payload": {
    "roomId": "550e8400-..."
  }
}
```

Sets `deletedAt` on the room. The room is removed from listings but data is preserved. Broadcasts `roomDeleted`.

### `transferOwnership`

Transfer room ownership to another user (owner only).

```json
{
  "type": "transferOwnership",
  "payload": {
    "roomId": "550e8400-...",
    "newOwnerUsername": "bob"
  }
}
```

The target user must be a member of the room. Updates `creatorId` and broadcasts `ownershipTransferred`.

### `createDM`

Create or find a direct message room with another user.

```json
{
  "type": "createDM",
  "payload": {
    "targetUsername": "bob"
  }
}
```

If a DM room already exists between these two users, returns it. Otherwise creates a new private room with `roomType: "dm"`. Responds with `roomJoined`.

### `voiceSignal`

Voice chat signals — join, leave, or send audio frames.

```json
{
  "type": "voiceSignal",
  "payload": {
    "roomId": "550e8400-...",
    "type": "join_voice",
    "data": ""
  }
}
```

Signal types:

| `type` value | `data` content | Purpose |
|---|---|---|
| `join_voice` | Empty | User enters the voice channel |
| `leave_voice` | Empty | User leaves the voice channel |
| `audio` | Base64-encoded Opus frame | Raw audio data (20ms, 48kHz, mono) |

The server routes these to the room's `RoomVoiceManager`.

---

## Server → Client Messages (15 types)

### `message`

An incoming chat message from another user.

```json
{
  "type": "message",
  "payload": {
    "id": "msg-uuid",
    "username": "bob",
    "ciphertext": "a3f8c9d2...",
    "timestamp": "2026-04-01T12:00:00.000Z",
    "messageType": "text",
    "imageUrl": "https://storage.example.com/image.enc"
  }
}
```

### `userJoined`

A user has joined the current room.

```json
{
  "type": "userJoined",
  "payload": {
    "username": "bob",
    "userId": "user-uuid"
  }
}
```

### `userLeft`

A user has left the current room.

```json
{
  "type": "userLeft",
  "payload": {
    "username": "bob",
    "userId": "user-uuid"
  }
}
```

### `roomJoined`

Confirmation of joining a room. Includes message history, encryption key, and online users.

```json
{
  "type": "roomJoined",
  "payload": {
    "roomId": "550e8400-...",
    "roomName": "general",
    "displayName": "#general",
    "roomType": "public",
    "encryptedKey": "a3f8c9d2...",
    "messages": [ ... ],
    "onlineUsers": [
      { "username": "alice", "userId": "..." }
    ]
  }
}
```

### `roomCreated`

Confirmation that a room was created.

```json
{
  "type": "roomCreated",
  "payload": {
    "roomId": "550e8400-...",
    "roomName": "team-chat",
    "displayName": "#team-chat",
    "roomType": "public",
    "encryptedKey": "a3f8c9d2..."
  }
}
```

### `roomsList`

List of available rooms in response to `listRooms`.

```json
{
  "type": "roomsList",
  "payload": {
    "publicRooms": [
      { "roomId": "...", "name": "general", "displayName": "#general", "roomType": "public", "memberCount": 5, "isJoined": true }
    ],
    "privateRooms": [
      { "roomId": "...", "name": "project-alpha", "displayName": "#project-alpha", "roomType": "private", "memberCount": 3, "isJoined": true }
    ]
  }
}
```

### `error`

Error response.

```json
{
  "type": "error",
  "payload": {
    "message": "Room not found",
    "code": "ROOM_NOT_FOUND"
  }
}
```

### `info`

Informational message.

```json
{
  "type": "info",
  "payload": {
    "message": "Welcome to Eurus!"
  }
}
```

### `userTyping`

A user is typing in the current room.

```json
{
  "type": "userTyping",
  "payload": {
    "username": "bob",
    "userId": "user-uuid"
  }
}
```

### `inviteCreated`

An invite code was generated.

```json
{
  "type": "inviteCreated",
  "payload": {
    "code": "aB3dE5gH",
    "roomId": "550e8400-...",
    "roomName": "general",
    "expiresAt": "2026-04-02T12:00:00.000Z"
  }
}
```

### `roomRenamed`

A room was renamed.

```json
{
  "type": "roomRenamed",
  "payload": {
    "roomId": "550e8400-...",
    "newName": "new-name",
    "displayName": "#new-name"
  }
}
```

### `roomDeleted`

A room was deleted.

```json
{
  "type": "roomDeleted",
  "payload": {
    "roomId": "550e8400-..."
  }
}
```

### `ownershipTransferred`

Room ownership was transferred.

```json
{
  "type": "ownershipTransferred",
  "payload": {
    "roomId": "550e8400-...",
    "newOwnerUsername": "bob",
    "newOwnerId": "user-uuid"
  }
}
```

### `voiceSignal`

Voice audio data from the server (mixed audio of other participants).

```json
{
  "type": "voiceSignal",
  "payload": {
    "roomId": "550e8400-...",
    "senderUserId": "server",
    "type": "audio",
    "data": "base64-encoded-opus-frame"
  }
}
```

### `voiceState`

Current list of users in a room's voice channel.

```json
{
  "type": "voiceState",
  "payload": {
    "roomId": "550e8400-...",
    "activeUsers": ["alice", "bob"]
  }
}
```

Broadcast whenever a user joins or leaves voice in a room.
