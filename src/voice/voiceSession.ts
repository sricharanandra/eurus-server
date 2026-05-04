import { OpusEncoder } from '@discordjs/opus';
import { WebSocket } from 'ws';
import { JitterBuffer, createSilenceFrame } from './jitterBuffer';

const OPUS_SAMPLE_RATE = 48000;
const OPUS_CHANNELS = 1;
const FRAME_SIZE = 960;

export class VoiceSession {
  public userId: string;
  public username: string;
  public ws: WebSocket;
  public encoder: OpusEncoder;
  public decoder: OpusEncoder;
  public jitterBuffer: JitterBuffer;
  public lastSeq: number = 0;
  public lastTimestamp: number = 0;
  public active: boolean = true;
  public currentPcm: Float32Array;

  private roomId: string;

  constructor(userId: string, username: string, roomId: string, ws: WebSocket) {
    this.userId = userId;
    this.username = username;
    this.roomId = roomId;
    this.ws = ws;
    this.encoder = new OpusEncoder(OPUS_SAMPLE_RATE, OPUS_CHANNELS);
    this.decoder = new OpusEncoder(OPUS_SAMPLE_RATE, OPUS_CHANNELS);
    this.jitterBuffer = new JitterBuffer();
    this.currentPcm = createSilenceFrame();
  }

  processAudio(seq: number, timestamp: number, opusData: Buffer): void {
    if (!this.active) return;

    this.lastSeq = seq;
    this.lastTimestamp = timestamp;

    let decoded: Buffer;
    try {
      decoded = this.decoder.decode(opusData);
    } catch (e) {
      console.log(`[VOICE] Decode error from ${this.userId}:`, e);
      return;
    }

    if (decoded.length < FRAME_SIZE * 2) {
      console.log(`[VOICE] Decode buffer too small from ${this.userId}`);
      return;
    }

    const floatBuf = new Float32Array(FRAME_SIZE);
    for (let i = 0; i < FRAME_SIZE; i++) {
      const sample = decoded.readInt16LE(i * 2);
      floatBuf[i] = sample / 32768.0;
    }

    this.currentPcm = floatBuf;
    this.jitterBuffer.push(seq, floatBuf, timestamp);
  }

  getPcm(): Float32Array {
    return this.currentPcm;
  }

  encodeAndSend(pcm: Float32Array, seq: number, timestamp: number): void {
    if (!this.active || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }

    const hasAudio = pcm.some(s => Math.abs(s) > 0.001);
    let opusData: Buffer;

    if (!hasAudio) {
      try {
        const silenceI16 = Buffer.alloc(FRAME_SIZE * 2);
        for (let i = 0; i < FRAME_SIZE; i++) {
          silenceI16.writeInt16LE(0, i * 2);
        }
        opusData = this.encoder.encode(silenceI16);
      } catch (e) {
        console.log(`[VOICE] Encode silence error for ${this.userId}:`, e);
        return;
      }
    } else {
      const int16 = Buffer.alloc(FRAME_SIZE * 2);
      for (let i = 0; i < FRAME_SIZE; i++) {
        const clamped = Math.max(-1.0, Math.min(1.0, pcm[i]));
        int16.writeInt16LE(Math.round(clamped * 32767), i * 2);
      }

      try {
        opusData = this.encoder.encode(int16);
      } catch (e) {
        console.log(`[VOICE] Encode error for ${this.userId}:`, e);
        return;
      }
    }

    const payload = JSON.stringify({
      type: 'audio',
      payload: {
        roomId: this.roomId,
        userId: this.userId,
        seq: seq,
        timestamp: timestamp,
        payload: opusData.toString('base64'),
      },
    });

    try {
      this.ws.send(payload);
    } catch (e) {
      console.log(`[VOICE] Send error for ${this.userId}:`, e);
    }
  }

  destroy(): void {
    this.active = false;
    this.jitterBuffer.reset();
    this.currentPcm = createSilenceFrame();
  }
}