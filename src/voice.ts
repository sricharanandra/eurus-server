import { OpusEncoder } from '@discordjs/opus';
import { WebSocket } from 'ws';
import { ConnectedUser } from './types';

const OPUS_SAMPLE_RATE = 48000;
const OPUS_CHANNELS = 1;
const FRAME_SIZE = 960; // 20ms at 48kHz

interface VoiceUser {
  userId: string;
  username: string;
  ws: WebSocket;
  pcmBuffer: Float32Array;
}

class RoomVoiceManager {
  private users: Map<string, VoiceUser> = new Map();
  private roomId: string;
  private encoder: OpusEncoder;
  private decoder: OpusEncoder;
  private mixInterval: NodeJS.Timeout | null = null;

  constructor(roomId: string) {
    this.roomId = roomId;
    this.encoder = new OpusEncoder(OPUS_SAMPLE_RATE, OPUS_CHANNELS);
    this.decoder = new OpusEncoder(OPUS_SAMPLE_RATE, OPUS_CHANNELS);
  }

  addUser(user: ConnectedUser): void {
    console.log(`[VOICE] ${user.username} joined voice in room ${this.roomId}`);

    const voiceUser: VoiceUser = {
      userId: user.userId,
      username: user.username,
      ws: user.ws,
      pcmBuffer: new Float32Array(FRAME_SIZE),
    };

    this.users.set(user.userId, voiceUser);

    if (!this.mixInterval) {
      this.startMixLoop();
    }
  }

  removeUser(userId: string): void {
    const user = this.users.get(userId);
    if (user) {
      console.log(`[VOICE] ${user.username} left voice in room ${this.roomId}`);
      this.users.delete(userId);
    }

    if (this.users.size === 0 && this.mixInterval) {
      clearInterval(this.mixInterval);
      this.mixInterval = null;
    }
  }

  processAudio(userId: string, opusData: Buffer): void {
    const sender = this.users.get(userId);
    if (!sender) return;

    let decoded: Buffer;
    try {
      decoded = this.decoder.decode(opusData);
    } catch (e) {
      console.log(`[VOICE] Decode error from ${userId}:`, e);
      return;
    }

    if (decoded.length < FRAME_SIZE * 2) return;

    const floatBuf = new Float32Array(FRAME_SIZE);
    for (let i = 0; i < FRAME_SIZE; i++) {
      const sample = decoded.readInt16LE(i * 2);
      floatBuf[i] = sample / 32768.0;
    }
    sender.pcmBuffer = floatBuf;
  }

  private startMixLoop(): void {
    this.mixInterval = setInterval(() => {
      this.mixAndSend();
    }, 20);
  }

  private mixAndSend(): void {
    if (this.users.size < 2) return;

    const userIds = Array.from(this.users.keys());

    for (const targetId of userIds) {
      const target = this.users.get(targetId)!;
      const mix = new Float32Array(FRAME_SIZE);

      for (const sourceId of userIds) {
        if (sourceId === targetId) continue;
        const source = this.users.get(sourceId);
        if (!source) continue;
        for (let i = 0; i < FRAME_SIZE; i++) {
          mix[i] += source.pcmBuffer[i];
        }
      }

      const hasAudio = mix.some(s => Math.abs(s) > 0.001);
      if (!hasAudio) continue;

      const int16 = Buffer.alloc(FRAME_SIZE * 2);
      for (let i = 0; i < FRAME_SIZE; i++) {
        const clamped = Math.max(-1.0, Math.min(1.0, mix[i]));
        int16.writeInt16LE(Math.round(clamped * 32767), i * 2);
      }

      let encoded: Buffer;
      try {
        encoded = this.encoder.encode(int16);
      } catch (e) {
        console.log(`[VOICE] Encode error for ${target.username}:`, e);
        continue;
      }

      const payload = JSON.stringify({
        type: 'voiceSignal',
        payload: {
          roomId: this.roomId,
          senderUserId: 'server',
          type: 'audio',
          data: encoded.toString('base64'),
        },
      });

      if (target.ws.readyState === 1) {
        target.ws.send(payload);
      }
    }
  }

  getVoiceUserIds(): Set<string> {
    return new Set(this.users.keys());
  }

  getVoiceUsernames(): string[] {
    return Array.from(this.users.values()).map(u => u.username);
  }

  destroy(): void {
    console.log(`[VOICE] Destroying RoomVoiceManager for room ${this.roomId}`);
    if (this.mixInterval) {
      clearInterval(this.mixInterval);
      this.mixInterval = null;
    }
    this.users.clear();
  }
}

export { RoomVoiceManager };
