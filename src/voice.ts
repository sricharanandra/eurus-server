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
    console.log(`[VOICE SFU] joinVoice called for ${user.username} in room ${this.roomId}`);

    const pc = new RTCPeerConnection({
      iceServers: [
        {
          urls: 'stun:stun.l.google.com:19302',
        },
      ],
    });

    console.log(`[VOICE SFU] Created RTCPeerConnection for ${user.username}`);

    const session: VoiceSession = {
      userId: user.userId,
      username: user.username,
      peerConnection: pc,
      roomId: this.roomId,
    };
    this.sessions.set(user.userId, session);
    console.log(`[VOICE SFU] Added session for ${user.username}, total sessions: ${this.sessions.size}`);

    // Handle incoming tracks from this user
    pc.ontrack = (event: any) => {
      const track = event.track;
      console.log(`[VOICE SFU] ontrack fired for ${user.username}, track kind: ${track.kind}`);
      session.audioTrack = track;

      // Forward this track to all other users
      for (const [otherId, otherSession] of this.sessions) {
        if (otherId !== user.userId) {
          try {
            console.log(`[VOICE SFU] Adding track from ${user.username} to ${otherId}`);
            otherSession.peerConnection.addTrack(track);
            console.log(`[VOICE SFU] Successfully added track from ${user.username} to ${otherId}`);
          } catch (e) {
            console.log(`[VOICE SFU] Error adding track to ${otherId}:`, e);
          }
        }
      }
    };

    pc.onicecandidate = (event: any) => {
      if (event.candidate) {
        console.log(`[VOICE SFU] ICE candidate generated for ${user.username}: ${event.candidate.candidate}`);
      } else {
        console.log(`[VOICE SFU] ICE candidate gathering complete for ${user.username}`);
      }
    };

    pc.onconnectionstatechange = () => {
      console.log(`[VOICE SFU] Connection state for ${user.username}: ${pc.connectionState}`);
    };

    // Create offer and set as local description
    const offer = await pc.createOffer();
    console.log(`[VOICE SFU] Created offer for ${user.username}, SDP preview: ${offer.sdp.substring(0, 80)}...`);
    await pc.setLocalDescription(offer);
    console.log(`[VOICE SFU] Set local description for ${user.username}, ICE gathering state: ${pc.iceGatheringState}`);

    // Wait for ICE gathering (max 2 seconds)
    let waited = 0;
    while (pc.iceGatheringState !== 'complete' && waited < 2000) {
      await new Promise(resolve => setTimeout(resolve, 100));
      waited += 100;
    }
    console.log(`[VOICE SFU] Waited ${waited}ms, ICE gathering state: ${pc.iceGatheringState}`);

    // Return the offer - client will handle it
    return offer;
  }

  async leaveVoice(userId: string): Promise<void> {
    console.log(`[VOICE SFU] leaveVoice called for ${userId}`);
    const session = this.sessions.get(userId);
    if (!session) {
      console.log(`[VOICE SFU] No session found for userId: ${userId}`);
      return;
    }

    try {
      await session.peerConnection.close();
      console.log(`[VOICE SFU] Closed peer connection for ${userId}`);
    } catch (e) {
      console.log(`[VOICE SFU] Error closing PC for ${userId}:`, e);
    }

    this.sessions.delete(userId);
    console.log(`[VOICE SFU] User ${userId} left, remaining sessions: ${this.sessions.size}`);

    for (const [otherId, otherSession] of this.sessions) {
      console.log(`[VOICE SFU] User ${otherId} still in voice`);
    }
  }

  async handleAnswer(userId: string, answer: RTCSessionDescription): Promise<void> {
    console.log(`[VOICE SFU] handleAnswer called for ${userId}`);
    const session = this.sessions.get(userId);
    if (!session) {
      console.log(`[VOICE SFU] No session found for answer from ${userId}`);
      return;
    }

    await session.peerConnection.setRemoteDescription(answer);
    console.log(`[VOICE SFU] Set remote description (answer) for ${userId}`);
  }

  async handleIceCandidate(userId: string, candidate: any): Promise<void> {
    const session = this.sessions.get(userId);
    if (!session) {
      console.log(`[VOICE SFU] No session found for ICE candidate from ${userId}`);
      return;
    }

    console.log(`[VOICE SFU] Adding ICE candidate from ${userId}: ${candidate.candidate}`);
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
