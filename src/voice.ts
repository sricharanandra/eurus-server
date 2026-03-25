import { RTCPeerConnection, RTCSessionDescription } from 'werift';
import { ConnectedUser } from './types';

interface VoiceSession {
  userId: string;
  username: string;
  peerConnection: RTCPeerConnection;
  audioTrack?: any;
  roomId: string;
}

class RoomVoiceManager {
  private sessions: Map<string, VoiceSession> = new Map();
  private roomId: string;

  constructor(roomId: string) {
    this.roomId = roomId;
  }

  async joinVoice(user: ConnectedUser): Promise<RTCSessionDescription> {
    const pc = new RTCPeerConnection({
      iceServers: [
        {
          urls: 'stun:stun.l.google.com:19302',
        },
      ],
    });

    const session: VoiceSession = {
      userId: user.userId,
      username: user.username,
      peerConnection: pc,
      roomId: this.roomId,
    };
    this.sessions.set(user.userId, session);

    pc.ontrack = (event: any) => {
      const track = event.track;
      session.audioTrack = track;

      for (const [otherId, otherSession] of this.sessions) {
        if (otherId !== user.userId) {
          try {
            otherSession.peerConnection.addTrack(track);
          } catch (e) {
            console.log(`[VOICE SFU] Error adding track to ${otherId}:`, e);
          }
        }
      }
    };

    pc.onicecandidate = (event: any) => {
      if (event.candidate) {
        console.log(`[VOICE SFU] ICE candidate for ${user.username}`);
      }
    };

    pc.onconnectionstatechange = () => {
      console.log(`[VOICE SFU] Connection state for ${user.username}: ${pc.connectionState}`);
    };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    console.log(`[VOICE SFU] Created offer for ${user.username}, sessions: ${this.sessions.size}`);
    return offer;
  }

  async leaveVoice(userId: string): Promise<void> {
    const session = this.sessions.get(userId);
    if (!session) {
      console.log(`[VOICE SFU] No session found for userId: ${userId}`);
      return;
    }

    try {
      await session.peerConnection.close();
    } catch (e) {
      console.log(`[VOICE SFU] Error closing PC for ${userId}:`, e);
    }

    this.sessions.delete(userId);
    console.log(`[VOICE SFU] User ${userId} left, remaining sessions: ${this.sessions.size}`);

    for (const [otherId, otherSession] of this.sessions) {
      console.log(`[VOICE SFU] Noting user ${otherId} still in voice`);
    }
  }

  async handleAnswer(userId: string, answer: RTCSessionDescription): Promise<void> {
    const session = this.sessions.get(userId);
    if (!session) {
      console.log(`[VOICE SFU] No session found for answer from ${userId}`);
      return;
    }

    await session.peerConnection.setRemoteDescription(answer);
    console.log(`[VOICE SFU] Set remote description for ${userId}`);
  }

  async handleIceCandidate(userId: string, candidate: any): Promise<void> {
    const session = this.sessions.get(userId);
    if (!session) {
      console.log(`[VOICE SFU] No session found for ICE candidate from ${userId}`);
      return;
    }

    await session.peerConnection.addIceCandidate(candidate);
    console.log(`[VOICE SFU] Added ICE candidate for ${userId}`);
  }

  async destroy(): Promise<void> {
    console.log(`[VOICE SFU] Destroying RoomVoiceManager for room ${this.roomId}`);
    for (const [userId, session] of this.sessions) {
      try {
        await session.peerConnection.close();
      } catch (e) {
        console.log(`[VOICE SFU] Error closing PC for ${userId}:`, e);
      }
    }
    this.sessions.clear();
  }

  getVoiceUsers(): Set<string> {
    return new Set(this.sessions.keys());
  }

  getSession(userId: string): VoiceSession | undefined {
    return this.sessions.get(userId);
  }

  getRoomId(): string {
    return this.roomId;
  }
}

export { RoomVoiceManager, VoiceSession };
