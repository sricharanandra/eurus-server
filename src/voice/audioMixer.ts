import { VoiceSession } from './voiceSession';
import { createSilenceFrame } from './jitterBuffer';

const FRAME_SIZE = 960;

export function mixAudio(
  targetSession: VoiceSession,
  allSessions: Map<string, VoiceSession>
): Float32Array {
  const otherSessions: VoiceSession[] = [];

  for (const [userId, session] of allSessions) {
    if (userId !== targetSession.userId && session.active) {
      otherSessions.push(session);
    }
  }

  if (otherSessions.length === 0) {
    return createSilenceFrame();
  }

  const mix = new Float32Array(FRAME_SIZE);

  for (const session of otherSessions) {
    const pcm = session.getPcm();
    for (let i = 0; i < FRAME_SIZE; i++) {
      mix[i] += pcm[i];
    }
  }

  const numSources = otherSessions.length;
  for (let i = 0; i < FRAME_SIZE; i++) {
    mix[i] = mix[i] / numSources;
    mix[i] = Math.max(-1.0, Math.min(1.0, mix[i]));
  }

  return mix;
}