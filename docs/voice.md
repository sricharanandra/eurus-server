# Voice System

The Eurus voice system is a Selective Forwarding Unit (SFU) that operates entirely over the existing authenticated WebSocket connection. There is no WebRTC, no ICE negotiation, no STUN servers, and no TURN relays. Audio flows as base64-encoded Opus frames over the same TCP/TLS connection used for chat.

## Architecture

```
Client A                    Server                    Client B
────────                    ──────                    ────────
  │                           │                         │
  │  capture (cpal)           │                         │
  │  encode (audiopus)        │                         │
  │  base64 encode            │                         │
  │───────── audio ──────────>│                         │
  │                           │  decode (@discordjs/opus)│
  │                           │  store PCM buffer        │
  │                           │                         │
  │                    20ms mix loop                     │
  │                           │  mix (A's PCM)           │
  │                           │  encode (@discordjs/opus)│
  │                           │  base64 encode           │
  │                           │─────── audio ───────────>│
  │                           │                         │
  │                           │                    decode (audiopus)
  │                           │                    playback (cpal)
```

## RoomVoiceManager

Each room with active voice users has one `RoomVoiceManager` instance. It is lazily created on the first `join_voice` signal and destroyed when the last user leaves.

### Lifecycle

1. **Creation** — When a user sends `voiceSignal` with `type: "join_voice"`, the server checks if `room.voiceManager` exists. If not, it creates a new `RoomVoiceManager(roomId)`.
2. **User added** — `addUser(user)` registers the user in the internal `users` map and starts the 20ms mix loop if not already running.
3. **Audio processing** — `processAudio(userId, opusData)` decodes incoming Opus frames and stores the PCM in the user's buffer.
4. **Mix loop** — A `setInterval` at 20ms iterates over all users, mixes everyone else's audio per-target, encodes, and sends back.
5. **User removed** — `removeUser(userId)` removes the user from the map. If no users remain, the mix interval is cleared.
6. **Destruction** — `destroy()` clears the mix interval and empties the user map. The `voiceManager` reference is set to `undefined` on the room.

### Audio Pipeline

#### Decode

Incoming Opus frames are decoded using `@discordjs/opus`:

```typescript
const decoded = this.decoder.decode(opusData); // Returns Buffer of Int16 PCM
```

The decoder outputs 16-bit signed little-endian PCM. This is converted to Float32 normalized to `[-1.0, 1.0]`:

```typescript
for (let i = 0; i < FRAME_SIZE; i++) {
  floatBuf[i] = decoded.readInt16LE(i * 2) / 32768.0;
}
```

#### Mix

For each target user, the server sums the PCM buffers of all other users:

```typescript
const mix = new Float32Array(FRAME_SIZE);
for (const sourceId of userIds) {
  if (sourceId === targetId) continue; // Exclude self
  const source = this.users.get(sourceId);
  for (let i = 0; i < FRAME_SIZE; i++) {
    mix[i] += source.pcmBuffer[i];
  }
}
```

This is a simple linear mix. For 2-5 participants, the summed values rarely exceed `[-1.0, 1.0]`, so clipping is minimal.

#### Silence Suppression

Before encoding, the mix is checked for audio activity:

```typescript
const hasAudio = mix.some(s => Math.abs(s) > 0.001);
if (!hasAudio) continue; // Skip encoding and sending
```

This prevents sending silent frames, reducing bandwidth and CPU usage when no one is speaking.

#### Encode

The mixed PCM is clamped, converted back to Int16, and encoded:

```typescript
const int16 = Buffer.alloc(FRAME_SIZE * 2);
for (let i = 0; i < FRAME_SIZE; i++) {
  const clamped = Math.max(-1.0, Math.min(1.0, mix[i]));
  int16.writeInt16LE(Math.round(clamped * 32767), i * 2);
}
const encoded = this.encoder.encode(int16);
```

The encoded Opus frame is base64-encoded and sent to the target user via WebSocket.

## Signal Types

| Signal | Direction | Purpose |
|---|---|---|
| `join_voice` | Client → Server | User enters the voice channel |
| `leave_voice` | Client → Server | User leaves the voice channel |
| `audio` | Client → Server | Raw Opus frame from user's microphone |
| `audio` | Server → Client | Mixed Opus frame (all other users) |

## Constants

| Constant | Value | Reason |
|---|---|---|
| Sample rate | 48,000 Hz | Opus native rate, CD-quality audio |
| Channels | 1 (mono) | Voice chat doesn't benefit from stereo |
| Frame size | 960 samples | 20ms at 48kHz — standard Opus frame |
| Mix interval | 20ms | Matches frame duration for real-time mixing |

## Why Not WebRTC?

WebRTC introduces significant complexity for a tool designed for 2-5 participants per room:

- **ICE negotiation** requires STUN/TURN servers and fails behind symmetric NAT.
- **PeerConnection lifecycle** requires managing offers, answers, and candidate exchanges.
- **Renegotiation** is required every time a participant joins or leaves, which is error-prone.
- **Additional ports** must be opened on the firewall for UDP media traffic.

Opus-over-WebSocket eliminates all of these issues. The latency difference between UDP WebRTC and TCP WebSocket is imperceptible for small-group voice chat, and the reliability of TCP is an advantage on lossy networks.

## Dependencies

- `@discordjs/opus` — Native Opus encoder/decoder. Requires `build-essential` and `libopus-dev` on the server for compilation.
- `base64` encoding — Built into Node.js via `Buffer.toString('base64')` and `Buffer.from(data, 'base64')`.
