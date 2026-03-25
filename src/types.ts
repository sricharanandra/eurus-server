import { WebSocket } from "ws";
import { RoomVoiceManager } from "./voice";

// ============================================================================
// PROTOCOL TYPES - Fixed to use "type" and camelCase consistently
// ============================================================================

// Base message structure for all WebSocket communication
export interface BaseMessage<T = any> {
  type: string;
  payload: T;
}

// ============================================================================
// CLIENT → SERVER MESSAGES
// ============================================================================

export interface JoinRoomPayload {
  roomId?: string;  // Optional: can join by UUID
  roomName?: string; // Optional: can join by name (e.g., "general")
}

export interface SendMessagePayload {
  roomId: string;
  ciphertext: string;
  messageType?: "text" | "image";  // Type of message
  imageData?: string;              // Base64-encoded encrypted image data (for uploads)
}

export interface CreateRoomPayload {
  name: string;        // e.g., "team-chat"
  displayName?: string; // e.g., "#team-chat" (auto-generated if not provided)
  roomType: "public" | "private";
}

export interface LeaveRoomPayload {
  roomId: string;
}

export interface ListRoomsPayload {
  // Empty payload - just request the list
}

export interface TypingPayload {
  roomId: string;
}

export interface CreateInvitePayload {
  roomId: string;
}

export interface JoinViaInvitePayload {
  code: string;
}

export interface RenameRoomPayload {
  roomId: string;
  newName: string;
}

export interface DeleteRoomPayload {
  roomId: string;
}

export interface TransferOwnershipPayload {
  roomId: string;
  newOwnerUsername: string;
}

export interface CreateDMPayload {
  targetUsername: string;
}

export interface VoiceSignalPayload {
  targetUserId?: string;
  senderUserId?: string;
  senderUsername?: string;
  roomId: string;
  type: string; // "offer" | "answer" | "candidate" | "join_voice" | "leave_voice"
  data: string;
}

export interface VoiceStatePayload {
  roomId: string;
  activeUsers: string[]; // List of Usernames
}

export type ClientMessage =
  | BaseMessage<JoinRoomPayload> & { type: "joinRoom" }
  | BaseMessage<SendMessagePayload> & { type: "sendMessage" }
  | BaseMessage<CreateRoomPayload> & { type: "createRoom" }
  | BaseMessage<LeaveRoomPayload> & { type: "leaveRoom" }
  | BaseMessage<ListRoomsPayload> & { type: "listRooms" }
  | BaseMessage<TypingPayload> & { type: "typing" }
  | BaseMessage<CreateInvitePayload> & { type: "createInvite" }
  | BaseMessage<JoinViaInvitePayload> & { type: "joinViaInvite" }
  | BaseMessage<RenameRoomPayload> & { type: "renameRoom" }
  | BaseMessage<DeleteRoomPayload> & { type: "deleteRoom" }
  | BaseMessage<TransferOwnershipPayload> & { type: "transferOwnership" }
  | BaseMessage<CreateDMPayload> & { type: "createDM" }
  | BaseMessage<VoiceSignalPayload> & { type: "voiceSignal" };

// ============================================================================
// SERVER → CLIENT MESSAGES
// ============================================================================

export interface MessagePayload {
  id: string;
  username: string;
  ciphertext: string;
  timestamp: string;
  messageType?: "text" | "image";  // Type of message
  imageUrl?: string;               // Object storage URL for images
  imageThumbnail?: string;         // Small base64 thumbnail for preview
}

export interface UserJoinedPayload {
  username: string;
  userId: string;
}

export interface UserLeftPayload {
  username: string;
  userId: string;
}

export interface OnlineUser {
  username: string;
  userId: string;
}

export interface RoomJoinedPayload {
  roomId: string;
  roomName: string;
  displayName: string;  // e.g., "#general"
  roomType: string;     // "public" or "private"
  encryptedKey: string; // Server-managed room encryption key
  messages: MessagePayload[];
  onlineUsers: OnlineUser[];  // Users currently in the room
}

export interface RoomCreatedPayload {
  roomId: string;
  roomName: string;
  displayName: string;
  roomType: string;
  encryptedKey: string;
}

export interface RoomInfo {
  roomId: string;
  name: string;
  displayName: string;
  roomType: "public" | "private";
  memberCount: number;
  isJoined: boolean; // Whether the requesting user is a member
}

export interface RoomsListPayload {
  publicRooms: RoomInfo[];
  privateRooms: RoomInfo[]; // Only rooms the user is a member of
}

export interface ErrorPayload {
  message: string;
  code?: string;
}

export interface InfoPayload {
  message: string;
}

export interface UserTypingPayload {
  username: string;
  userId: string;
}

export interface InviteCreatedPayload {
  code: string;
  roomId: string;
  roomName: string;
  expiresAt: string;
}

export interface RoomRenamedPayload {
  roomId: string;
  newName: string;
  displayName: string;
}

export interface RoomDeletedPayload {
  roomId: string;
}

export interface OwnershipTransferredPayload {
  roomId: string;
  newOwnerUsername: string;
  newOwnerId: string;
}

export type ServerMessage =
  | BaseMessage<MessagePayload> & { type: "message" }
  | BaseMessage<UserJoinedPayload> & { type: "userJoined" }
  | BaseMessage<UserLeftPayload> & { type: "userLeft" }
  | BaseMessage<RoomJoinedPayload> & { type: "roomJoined" }
  | BaseMessage<RoomCreatedPayload> & { type: "roomCreated" }
  | BaseMessage<RoomsListPayload> & { type: "roomsList" }
  | BaseMessage<ErrorPayload> & { type: "error" }
  | BaseMessage<InfoPayload> & { type: "info" }
  | BaseMessage<UserTypingPayload> & { type: "userTyping" }
  | BaseMessage<InviteCreatedPayload> & { type: "inviteCreated" }
  | BaseMessage<RoomRenamedPayload> & { type: "roomRenamed" }
  | BaseMessage<RoomDeletedPayload> & { type: "roomDeleted" }
  | BaseMessage<OwnershipTransferredPayload> & { type: "ownershipTransferred" }
  | BaseMessage<VoiceSignalPayload> & { type: "voiceSignal" }
  | BaseMessage<VoiceStatePayload> & { type: "voiceState" };

// ============================================================================
// SERVER STATE TYPES
// ============================================================================

export interface ConnectedUser {
  userId: string;
  username: string;
  ws: WebSocket;
  currentRoomId: string | null;
  isAuthenticated: boolean;
}

export interface ActiveRoom {
  id: string;
  name: string;
  displayName: string;
  roomType: string;
  encryptedKey: string;
  users: ConnectedUser[];
  voiceManager?: RoomVoiceManager; // SFU manager for voice in this room
}

// ============================================================================
// AUTHENTICATION TYPES
// ============================================================================

export interface AuthPayload {
  token: string;
}

export interface RegisterRequest {
  username: string;
  publicKey: string;
  keyType: "ed25519" | "rsa";
}

export interface RegisterResponse {
  userId: string;
  username: string;
  token: string;
}

export interface ChallengeRequest {
  username: string;
}

export interface ChallengeResponse {
  challenge: string;
}

export interface VerifyRequest {
  username: string;
  signature: string;
  publicKey: string;
}

export interface VerifyResponse {
  token: string;
  userId: string;
  username: string;
}

export interface JWTPayload {
  userId: string;
  username: string;
  iat?: number;
  exp?: number;
}
