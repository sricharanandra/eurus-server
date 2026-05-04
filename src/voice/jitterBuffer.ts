const FRAME_SIZE = 960;
const BUFFER_SIZE = 5;
const MAX_MISSING_FRAMES = 2;

interface JitterFrame {
  seq: number;
  pcm: Float32Array;
  timestamp: number;
}

export class JitterBuffer {
  private buffer: Map<number, JitterFrame> = new Map();
  private expectedSeq: number = 0;
  private missingFrameCount: number = 0;
  private isInitialized: boolean = false;

  push(seq: number, pcm: Float32Array, timestamp: number): void {
    if (!this.isInitialized) {
      this.expectedSeq = seq;
      this.isInitialized = true;
    }

    if (seq < this.expectedSeq - MAX_MISSING_FRAMES) {
      console.log(`[JITTER] Dropping old frame seq=${seq} expected=${this.expectedSeq}`);
      return;
    }

    if (this.buffer.size >= BUFFER_SIZE) {
      const oldestSeq = Math.min(...this.buffer.keys());
      this.buffer.delete(oldestSeq);
      console.log(`[JITTER] Buffer full, dropped oldest seq=${oldestSeq}`);
    }

    this.buffer.set(seq, { seq, pcm: pcm.slice(), timestamp });
  }

  pop(): Float32Array | null {
    const frame = this.buffer.get(this.expectedSeq);

    if (frame) {
      this.buffer.delete(this.expectedSeq);
      this.missingFrameCount = 0;
      this.expectedSeq++;
      return frame.pcm;
    }

    this.missingFrameCount++;

    if (this.missingFrameCount > MAX_MISSING_FRAMES) {
      console.log(`[JITTER] Skipping ${this.missingFrameCount} missing frames`);
      this.expectedSeq += this.missingFrameCount;
      this.missingFrameCount = 0;
      return null;
    }

    return null;
  }

  reset(): void {
    this.buffer.clear();
    this.expectedSeq = 0;
    this.missingFrameCount = 0;
    this.isInitialized = false;
  }

  getExpectedSeq(): number {
    return this.expectedSeq;
  }

  isEmpty(): boolean {
    return this.buffer.size === 0;
  }
}

export function createSilenceFrame(): Float32Array<ArrayBufferLike> {
  return new Float32Array(FRAME_SIZE);
}