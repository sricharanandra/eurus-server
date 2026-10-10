const FRAME_SIZE = 960;
const MAX_FRAMES = 5;

// Bounded FIFO of decoded frames. The mixer pops one frame per tick and gets
// null when the sender is silent (muted, idle, or late). WebSocket delivery is
// ordered, so there's no sequence prediction: a sender that pauses (mute) and
// resumes is heard again immediately. When a burst overflows the buffer the
// oldest frames are dropped to keep latency bounded.
export class JitterBuffer {
  private frames: Float32Array[] = [];

  push(pcm: Float32Array): void {
    if (this.frames.length >= MAX_FRAMES) {
      this.frames.shift();
    }
    this.frames.push(pcm);
  }

  pop(): Float32Array | null {
    return this.frames.shift() ?? null;
  }

  reset(): void {
    this.frames = [];
  }

  isEmpty(): boolean {
    return this.frames.length === 0;
  }
}

export function createSilenceFrame(): Float32Array<ArrayBufferLike> {
  return new Float32Array(FRAME_SIZE);
}
