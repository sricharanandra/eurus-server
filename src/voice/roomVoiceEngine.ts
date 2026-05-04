import { WebSocket } from 'ws';
import { VoiceSession } from './voiceSession';
import { mixAudio } from './audioMixer';

const MIX_INTERVAL_MS = 20;
const TIMESTAMP_INCREMENT = 20;

export class RoomVoiceEngine {
  private roomId: string;
  private sessions: Map<string, VoiceSession> = new Map();
  private mixInterval: NodeJS.Timeout | null = null;
  private globalSeq: number = 0;
  private globalTimestamp: number = 0;

  constructor(roomId: string) {
    this.roomId = roomId;
    this.startMixLoop();
  }

  addUser(userId: string, username: string, ws: WebSocket): void {
    console.log(`[VOICE] ${username} (${userId}) joined voice in room ${this.roomId}`);

    const session = new VoiceSession(userId, username, this.roomId, ws);
    this.sessions.set(userId, session);
  }

  removeUser(userId: string): void {
    const session = this.sessions.get(userId);
    if (session) {
      console.log(`[VOICE] ${session.username} left voice in room ${this.roomId}`);
      session.destroy();
      this.sessions.delete(userId);
    }

    if (this.sessions.size === 0) {
      this.stopMixLoop();
    }
  }

  processAudio(userId: string, seq: number, timestamp: number, opusData: Buffer): void {
    const session = this.sessions.get(userId);
    if (!session) {
      console.log(`[VOICE] No session found for user ${userId}`);
      return;
    }

    session.processAudio(seq, timestamp, opusData);
  }

  private startMixLoop(): void {
    if (this.mixInterval) return;

    this.mixInterval = setInterval(() => {
      this.mixAndSend();
    }, MIX_INTERVAL_MS);
  }

  private stopMixLoop(): void {
    if (this.mixInterval) {
      clearInterval(this.mixInterval);
      this.mixInterval = null;
    }
  }

  private mixAndSend(): void {
    if (this.sessions.size === 0) {
      return;
    }

    this.globalSeq++;
    this.globalTimestamp += TIMESTAMP_INCREMENT;

    for (const [userId, session] of this.sessions) {
      if (!session.active) continue;

      const mixedPcm = mixAudio(session, this.sessions);
      session.encodeAndSend(mixedPcm, this.globalSeq, this.globalTimestamp);
    }
  }

  getVoiceUserIds(): Set<string> {
    return new Set(this.sessions.keys());
  }

  getVoiceUsernames(): string[] {
    return Array.from(this.sessions.values()).map(s => s.username);
  }

  destroy(): void {
    console.log(`[VOICE] Destroying RoomVoiceEngine for room ${this.roomId}`);
    this.stopMixLoop();

    for (const [_, session] of this.sessions) {
      session.destroy();
    }
    this.sessions.clear();
  }

  handleUserDisconnect(userId: string): void {
    this.removeUser(userId);
  }
}