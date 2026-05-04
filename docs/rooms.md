# Rooms

Rooms are the fundamental organizational unit in Eurus. Every message belongs to a room, every voice session is scoped to a room, and encryption keys are managed per room.

## Room Types

| Type | Visibility | Join Method | Use Case |
|---|---|---|---|
| `public` | Listed to all users | Direct join | General channels, open discussions |
| `private` | Listed only to members | Invite code or member addition | Team channels, restricted groups |
| `dm` | Not listed | `createDM` with target username | One-on-one conversations |

### DM Rooms

Direct message rooms are a special subtype of private rooms with exactly two members. When a user calls `createDM` with a target username:

1. The server searches for an existing DM room between the two users.
2. If found, returns the existing room (no duplicate DM rooms).
3. If not found, creates a new room with `roomType: "dm"`, adds both users as members, and generates an encryption key.

DM rooms are never listed in room listings. They are only accessible to their two members.

## Room Lifecycle

### Creation

A room is created via the `createRoom` WebSocket message. The server:

1. Validates the room name (unique, URL-safe characters).
2. Generates a random encryption key for the room.
3. Creates the room record in the database with the creator as `creatorId`.
4. Adds the creator as a member (`RoomMember` record).
5. Stores the room key in `RoomKey` for the creator.
6. Adds the room to the in-memory `activeRooms` map.
7. Returns `roomCreated` to the creator.

### Joining

A user joins a room via `joinRoom` (by ID or name) or `joinViaInvite` (by invite code). The server:

1. Looks up the room in the database.
2. Verifies the room exists and is not deleted.
3. For private rooms, verifies the user is a member or has a valid invite code.
4. Creates a `RoomMember` record if not already a member.
5. Fetches the user's encrypted room key from `RoomKey`.
6. Fetches recent message history (last 50 messages).
7. Adds the user to the in-memory `activeRooms` list.
8. Returns `roomJoined` with the room details, key, messages, and online users.
9. Broadcasts `userJoined` to existing room members.

### Leaving

A user leaves via `leaveRoom` or by disconnecting. The server:

1. Removes the user from the in-memory room's `users` array.
2. Broadcasts `userLeft` to remaining members.
3. If the user was in voice, removes them from the `RoomVoiceManager`.
4. The `RoomMember` database record is **not** deleted — membership persists across sessions.

### Deletion

A room is soft-deleted via `deleteRoom` (owner only). The server:

1. Sets `deletedAt` on the room record.
2. Removes the room from `activeRooms`.
3. Destroys the `RoomVoiceManager` if active.
4. Broadcasts `roomDeleted` to all connected members.
5. Messages and room keys are preserved in the database.

## Invites

Invite codes provide a secure way to add users to private rooms without pre-provisioning membership.

### Code Generation

- 8-character alphanumeric string (e.g., `aB3dE5gH`).
- Single-use: marked as used after one successful join.
- 24-hour expiry from creation time.
- Created by any room member via `createInvite`.

### Join Flow

1. User sends `joinViaInvite` with the code.
2. Server looks up the invite by code.
3. Validates: exists, not expired, not already used.
4. Adds the user to the room's members.
5. Marks the invite as used (`usedById`, `usedAt`).
6. Returns `roomJoined` with the room details and encryption key.

## Membership

Room membership is tracked in the `RoomMember` table with a composite primary key of `[roomId, userId]`. Membership is persistent — it survives server restarts and client disconnections.

### In-Memory vs Database

- **Database (`RoomMember`)** — Persistent membership record. Determines who *can* join a room.
- **In-memory (`ActiveRoom.users`)** — Currently connected users in a room. Determines who *is* in a room right now.

A user can be a member (database) without being connected (in-memory). The server only loads a room into `activeRooms` when at least one member connects to it.

## Ownership

The room creator (`creatorId`) is the default owner. Owners can:

- Rename the room (`renameRoom`)
- Delete the room (`deleteRoom`)
- Transfer ownership to another member (`transferOwnership`)

Ownership transfer requires the target user to be a current member of the room. After transfer, the previous owner remains a member but loses administrative privileges.

## Encryption Keys

Each room has a server-generated AES-256 encryption key. This key is:

1. Generated when the room is created.
2. Stored in `RoomKey` per member, encrypted for that specific user.
3. Sent to the client in the `roomJoined` payload as `encryptedKey`.
4. Used by the client to encrypt/decrypt all messages in the room.

The server manages key distribution but never sees the plaintext. When a new member joins, the server generates a new `RoomKey` entry for them with the room's encryption key.
