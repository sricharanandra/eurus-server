const FRAME_SIZE = 960;

export function mixAudio(
  targetUserId: string,
  frames: Map<string, Float32Array>
): Float32Array {
  let numSources = 0;
  let mix: Float32Array | null = null;

  for (const [userId, pcm] of frames) {
    if (userId === targetUserId) continue;
    if (!mix) {
      mix = new Float32Array(FRAME_SIZE);
    }
    for (let i = 0; i < FRAME_SIZE; i++) {
      mix[i] += pcm[i];
    }
    numSources++;
  }

  if (!mix || numSources === 0) {
    return new Float32Array(FRAME_SIZE);
  }

  for (let i = 0; i < FRAME_SIZE; i++) {
    mix[i] = mix[i] / numSources;
    mix[i] = Math.max(-1.0, Math.min(1.0, mix[i]));
  }

  return mix;
}
