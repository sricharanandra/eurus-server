const FRAME_SIZE = 960;
const ACTIVE_THRESHOLD = 0.001;

export function mixAudio(
  targetUserId: string,
  frames: Map<string, Float32Array>
): Float32Array {
  let activeSources = 0;
  let mix: Float32Array | null = null;

  for (const [userId, pcm] of frames) {
    if (userId === targetUserId) continue;
    if (!mix) {
      mix = new Float32Array(FRAME_SIZE);
    }
    let peak = 0;
    for (let i = 0; i < FRAME_SIZE; i++) {
      mix[i] += pcm[i];
      const abs = pcm[i] < 0 ? -pcm[i] : pcm[i];
      if (abs > peak) peak = abs;
    }
    // Silent sources shouldn't dilute the gain of active speakers
    if (peak > ACTIVE_THRESHOLD) {
      activeSources++;
    }
  }

  if (!mix || activeSources === 0) {
    return new Float32Array(FRAME_SIZE);
  }

  for (let i = 0; i < FRAME_SIZE; i++) {
    mix[i] = mix[i] / activeSources;
    mix[i] = Math.max(-1.0, Math.min(1.0, mix[i]));
  }

  return mix;
}
