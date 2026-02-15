import { WebSocketServer, WebSocket } from "ws";
import { createServer } from "http";
import dotenv from 'dotenv';
import { v4 as uuidv4 } from 'uuid';
import { prisma } from './database';
import { verifyToken } from './auth';
import api from './api';
import {
  ConnectedUser,
  ActiveRoom,
  ClientMessage,
  ServerMessage,
  JoinRoomPayload,
  SendMessagePayload,
  CreateRoomPayload,
  LeaveRoomPayload,
  ListRoomsPayload,
  CreateInvitePayload,
  JoinViaInvitePayload,
  RenameRoomPayload,
  DeleteRoomPayload,
  TransferOwnershipPayload,
  CreateDMPayload,
  VoiceSignalPayload,
  BaseMessage,
} from './types';
import crypto from 'crypto';

// Load environment variables
dotenv.config();

const PORT = parseInt(process.env.PORT || '8080');
const HOST = process.env.HOST || '0.0.0.0';
const isProduction = process.env.NODE_ENV === 'production';
const isDevelopment = process.env.NODE_ENV === 'development';

// Startup logging
console.log(`[STARTUP] Eurus Server v1.0.0`);
console.log(`[STARTUP] Environment: ${process.env.NODE_ENV || 'development'}`);
console.log(`[STARTUP] Host: ${HOST}:${PORT}`);
console.log(`[STARTUP] Authentication: ${isProduction ? 'SSH Keys Required' : 'Development Mode (simpleLogin enabled)'}`);
console.log(`[STARTUP] Database: ${process.env.DATABASE_URL ? 'Configured' : 'Not configured'}`);

// ============================================================================
// SERVER STATE
// ============================================================================

const connectedUsers = new Map<WebSocket, ConnectedUser>();
const activeRooms = new Map<string, ActiveRoom>();

// ============================================================================
// HTTP + WEBSOCKET SERVER
// ============================================================================

// Create HTTP server for both API and WebSocket
const httpServer = createServer(api);

// Create WebSocket server
const wss = new WebSocketServer({ 
  server: httpServer,
  path: '/ws',
});

console.log("=====================================================");
console.log("🚀 Eurus Server Starting...");
console.log("=====================================================");

// ============================================================================
// WEBSOCKET CONNECTION HANDLER
// ============================================================================

wss.on("connection", async (ws: WebSocket, request) => {
  console.log(`[WS] New client connected from ${request.socket.remoteAddress}`);

  // Parse token from query string
  const url = new URL(request.url || '', `http://${request.headers.host}`);
  const token = url.searchParams.get('token');

  let user: ConnectedUser | null = null;

  // If token provided, verify it
  if (token) {
    const payload = verifyToken(token);
    if (payload) {
      user = {
        userId: payload.userId,
        username: payload.username,
        ws,
        currentRoomId: null,
        isAuthenticated: true,
      };
      console.log(`[AUTH] User authenticated: ${user.username} (${user.userId})`);
    } else {
      console.log('[AUTH] Invalid token provided');
    }
  }

  // If no valid authentication, create guest user in database
  if (!user) {
    const guestUsername = `Guest_${Math.random().toString(36).substring(7)}`;
    
    // Create guest user in database
    const dbUser = await prisma.user.create({
      data: {
        username: guestUsername,
      },
    });
    
    user = {
      userId: dbUser.id,
      username: dbUser.username,
      ws,
      currentRoomId: null,
      isAuthenticated: false,
    };
    console.log(`[AUTH] Guest user created: ${guestUsername} (${dbUser.id})`);
  }

  connectedUsers.set(ws, user);

  // Send welcome message
  sendMessage(ws, {
    type: "info",
    payload: {
      message: `Welcome ${user.username}! You are ${user.isAuthenticated ? 'authenticated' : 'connected as guest'}.`,
    },
  });

  // ============================================================================
  // MESSAGE HANDLER
  // ============================================================================

  ws.on("message", async (data: Buffer) => {
    try {
      const messageText = data.toString();
      console.log(`[WS] ← Received from ${user?.username}:`, messageText);

      const message: ClientMessage = JSON.parse(messageText);

      if (!message.type) {
        return sendError(ws, "Message missing 'type' field");
      }

      const currentUser = connectedUsers.get(ws);
      if (!currentUser) {
        return sendError(ws, "User not found");
      }

      // Handle different message types
      switch (message.type) {
        case "joinRoom":
          await handleJoinRoom(currentUser, message.payload);
          break;

        case "sendMessage":
          await handleSendMessage(currentUser, message.payload);
          break;

        case "createRoom":
          await handleCreateRoom(currentUser, message.payload);
          break;

        case "leaveRoom":
          await handleLeaveRoom(currentUser, message.payload);
          break;

        case "listRooms":
          await handleListRooms(currentUser, message.payload);
          break;

        case "typing":
          handleTyping(currentUser, message.payload);
          break;

        case "createInvite":
          await handleCreateInvite(currentUser, message.payload);
          break;

        case "joinViaInvite":
          await handleJoinViaInvite(currentUser, message.payload);
          break;

        case "renameRoom":
          await handleRenameRoom(currentUser, message.payload);
          break;

        case "deleteRoom":
          await handleDeleteRoom(currentUser, message.payload);
          break;

        case "transferOwnership":
          await handleTransferOwnership(currentUser, message.payload);
          break;

        case "createDM":
          await handleCreateDM(currentUser, message.payload);
          break;

        case "voiceSignal":
          handleVoiceSignal(currentUser, message.payload);
          break;

        default:
          console.error(`[WS] Unknown message type: ${(message as any).type}`);
          sendError(ws, `Unknown message type: ${(message as any).type}`);
      }
    } catch (error: any) {
      console.error("[WS] Error parsing message:", error);
      sendError(ws, "Invalid message format");
    }
  });

  // ============================================================================
  // DISCONNECT HANDLER
  // ============================================================================

  ws.on("close", () => {
    const user = connectedUsers.get(ws);
    if (user) {
      console.log(`[WS] User disconnected: ${user.username}`);
      handleDisconnect(user);
      connectedUsers.delete(ws);
    }
  });

  ws.on("error", (error) => {
    console.error("[WS] WebSocket error:", error);
  });
});

// ============================================================================
// MESSAGE HANDLERS
// ============================================================================

async function handleJoinRoom(user: ConnectedUser, payload: JoinRoomPayload) {
  const { roomId, roomName } = payload;

  if (!roomId && !roomName) {
    return sendError(user.ws, "Room ID or room name is required");
  }

  console.log(`[ROOM] ${user.username} attempting to join room: ${roomId || roomName}`);

  // Check if room exists in database (by ID or name)
  const room = await prisma.room.findFirst({
    where: {
      OR: [
        roomId ? { id: roomId } : {},
        roomName ? { name: roomName } : {},
      ],
      deletedAt: null,
    },
    include: {
      messages: {
        include: {
          sender: {
            select: { username: true },
          },
        },
        orderBy: { createdAt: 'desc' },
        take: 50,
      },
      members: {
        where: { userId: user.userId },
      },
    },
  });

  if (!room) {
    return sendError(user.ws, "Room not found");
  }

  // Check if room is private and user is not a member
  if (room.roomType === 'private' && room.members.length === 0) {
    return sendError(user.ws, "You don't have access to this private room");
  }

  // Leave current room if in one
  if (user.currentRoomId) {
    await handleLeaveRoom(user, { roomId: user.currentRoomId });
  }

  // Add user to room membership in database
  await prisma.roomMember.upsert({
    where: {
      roomId_userId: {
        roomId: room.id,
        userId: user.userId,
      },
    },
    create: {
      roomId: room.id,
      userId: user.userId,
    },
    update: {},
  });

  // Create or get active room
  let activeRoom = activeRooms.get(room.id);
  if (!activeRoom) {
    activeRoom = {
      id: room.id,
      name: room.name,
      displayName: room.displayName,
      roomType: room.roomType,
      encryptedKey: room.encryptedKey || '',
      users: [],
    };
    activeRooms.set(room.id, activeRoom);
  }

  // Add user to active room
  if (!activeRoom.users.find(u => u.userId === user.userId)) {
    activeRoom.users.push(user);
  }
  user.currentRoomId = room.id;

  // Send room joined confirmation with message history and encryption key
  // Messages are fetched in desc order (newest first), reverse for chronological display
  const messages = room.messages.map(m => ({
    id: m.id,
    username: m.sender.username,
    ciphertext: m.ciphertext,
    timestamp: m.createdAt.toISOString(),
  })).reverse();

  // Get online users in the room
  const onlineUsers = activeRoom.users.map(u => ({
    username: u.username,
    userId: u.userId,
  }));

  sendMessage(user.ws, {
    type: "roomJoined",
    payload: {
      roomId: room.id,
      roomName: room.name,
      displayName: room.displayName,
      roomType: room.roomType,
      encryptedKey: room.encryptedKey || '',
      messages,
      onlineUsers,
    },
  });

  // Broadcast to others in room
  broadcastToRoom(room.id, {
    type: "userJoined",
    payload: {
      username: user.username,
      userId: user.userId,
    },
  }, user.ws);

  console.log(`[ROOM] ${user.username} joined room: ${room.displayName} (${room.id})`);
}

async function handleSendMessage(user: ConnectedUser, payload: SendMessagePayload) {
  const { roomId, ciphertext, messageType, imageData } = payload;

  if (!user.currentRoomId || user.currentRoomId !== roomId) {
    return sendError(user.ws, "You must be in the room to send messages");
  }

  if (!ciphertext && !imageData) {
    return sendError(user.ws, "Message content or image is required");
  }

  console.log(`[MSG] ${user.username} sending ${messageType || "text"} message to room ${roomId}`);

  let imageUrl: string | null = null;
  let imageThumbnail: string | null = null;

  // Handle image upload if provided
  if (messageType === "image" && imageData) {
    try {
      const { uploadImage, generateImageId, validateImageSize } = await import("./storage.js");
      const { processImage, generateThumbnail } = await import("./images.js");

      // Decode base64 image data (it's already encrypted by client)
      const encryptedImageBuffer = Buffer.from(imageData, "base64");

      // Validate size (encrypted data)
      if (!validateImageSize(encryptedImageBuffer.length)) {
        return sendError(user.ws, "Image too large (max 10MB)");
      }

      // Generate unique ID for the image
      const imageId = generateImageId();

      // Upload encrypted image to Oracle Object Storage
      imageUrl = await uploadImage(encryptedImageBuffer, imageId);

      // Note: We don't generate thumbnails for encrypted images
      // Client will need to decrypt and display the full image
      console.log(`[IMG] Image uploaded: ${imageUrl}`);
    } catch (error: any) {
      console.error("[IMG] Failed to upload image:", error);
      return sendError(user.ws, "Failed to upload image");
    }
  }

  // Save message to database
  const message = await prisma.message.create({
    data: {
      roomId,
      senderId: user.userId,
      ciphertext: ciphertext || "",
      messageType: messageType || "text",
      imageUrl: imageUrl,
    },
  });

  // Broadcast to all users in room
  const messagePayload = {
    id: message.id,
    username: user.username,
    ciphertext: message.ciphertext,
    timestamp: message.createdAt.toISOString(),
    messageType: message.messageType as "text" | "image" | undefined,
    imageUrl: message.imageUrl || undefined,
  };

  broadcastToRoom(roomId, {
    type: "message",
    payload: messagePayload,
  });

  console.log(`[MSG] Message ${message.id} broadcast to room ${roomId}`);
}

function handleTyping(user: ConnectedUser, payload: { roomId: string }) {
  const { roomId } = payload;

  if (!user.currentRoomId || user.currentRoomId !== roomId) {
    return; // Silently ignore if not in the room
  }

  // Broadcast typing indicator to other users in room
  broadcastToRoom(roomId, {
    type: "userTyping",
    payload: {
      username: user.username,
      userId: user.userId,
    },
  }, user.ws); // Exclude the sender
}

async function handleCreateInvite(user: ConnectedUser, payload: CreateInvitePayload) {
  const { roomId } = payload;

  if (!roomId) {
    return sendError(user.ws, "Room ID is required");
  }

  // Check if user is a member of the room
  const membership = await prisma.roomMember.findUnique({
    where: {
      roomId_userId: {
        roomId,
        userId: user.userId,
      },
    },
    include: {
      room: true,
    },
  });

  if (!membership) {
    return sendError(user.ws, "You must be a member of the room to create invites");
  }

  // Generate 8-character alphanumeric code
  const code = crypto.randomBytes(4).toString('hex').toUpperCase();
  
  // Set expiry to 24 hours from now
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

  // Create invite in database
  const invite = await prisma.roomInvite.create({
    data: {
      code,
      roomId,
      createdById: user.userId,
      expiresAt,
    },
  });

  console.log(`[INVITE] ${user.username} created invite ${code} for room ${membership.room.displayName}`);

  sendMessage(user.ws, {
    type: "inviteCreated",
    payload: {
      code: invite.code,
      roomId: invite.roomId,
      roomName: membership.room.name,
      expiresAt: invite.expiresAt.toISOString(),
    },
  });
}

async function handleJoinViaInvite(user: ConnectedUser, payload: JoinViaInvitePayload) {
  const { code } = payload;

  if (!code) {
    return sendError(user.ws, "Invite code is required");
  }

  // Find the invite
  const invite = await prisma.roomInvite.findUnique({
    where: { code: code.toUpperCase() },
    include: {
      room: {
        include: {
          messages: {
            include: {
              sender: {
                select: { username: true },
              },
            },
            orderBy: { createdAt: 'desc' },
            take: 50,
          },
        },
      },
    },
  });

  if (!invite) {
    return sendError(user.ws, "Invalid invite code");
  }

  // Check if expired
  if (new Date() > invite.expiresAt) {
    return sendError(user.ws, "Invite code has expired");
  }

  // Check if already used
  if (invite.usedById) {
    return sendError(user.ws, "Invite code has already been used");
  }

  // Check if room is deleted
  if (invite.room.deletedAt) {
    return sendError(user.ws, "Room no longer exists");
  }

  // Check if user is already a member
  const existingMembership = await prisma.roomMember.findUnique({
    where: {
      roomId_userId: {
        roomId: invite.roomId,
        userId: user.userId,
      },
    },
  });

  if (existingMembership) {
    return sendError(user.ws, "You are already a member of this room");
  }

  // Mark invite as used
  await prisma.roomInvite.update({
    where: { id: invite.id },
    data: {
      usedById: user.userId,
      usedAt: new Date(),
    },
  });

  // Add user to room membership
  await prisma.roomMember.create({
    data: {
      roomId: invite.roomId,
      userId: user.userId,
    },
  });

  console.log(`[INVITE] ${user.username} joined room ${invite.room.displayName} via invite ${code}`);

  // Leave current room if in one
  if (user.currentRoomId) {
    await handleLeaveRoom(user, { roomId: user.currentRoomId });
  }

  // Create or get active room
  let activeRoom = activeRooms.get(invite.room.id);
  if (!activeRoom) {
    activeRoom = {
      id: invite.room.id,
      name: invite.room.name,
      displayName: invite.room.displayName,
      roomType: invite.room.roomType,
      encryptedKey: invite.room.encryptedKey || '',
      users: [],
    };
    activeRooms.set(invite.room.id, activeRoom);
  }

  // Add user to active room
  if (!activeRoom.users.find(u => u.userId === user.userId)) {
    activeRoom.users.push(user);
  }
  user.currentRoomId = invite.room.id;

  // Send room joined confirmation
  const messages = invite.room.messages.map(m => ({
    id: m.id,
    username: m.sender.username,
    ciphertext: m.ciphertext,
    timestamp: m.createdAt.toISOString(),
  })).reverse();

  const onlineUsers = activeRoom.users.map(u => ({
    username: u.username,
    userId: u.userId,
  }));

  sendMessage(user.ws, {
    type: "roomJoined",
    payload: {
      roomId: invite.room.id,
      roomName: invite.room.name,
      displayName: invite.room.displayName,
      roomType: invite.room.roomType,
      encryptedKey: invite.room.encryptedKey || '',
      messages,
      onlineUsers,
    },
  });

  // Broadcast to others in room
  broadcastToRoom(invite.room.id, {
    type: "userJoined",
    payload: {
      username: user.username,
      userId: user.userId,
    },
  }, user.ws);
}

async function handleRenameRoom(user: ConnectedUser, payload: RenameRoomPayload) {
  const { roomId, newName } = payload;

  if (!roomId || !newName) {
    return sendError(user.ws, "Room ID and new name are required");
  }

  // Find room and check ownership
  const room = await prisma.room.findUnique({
    where: { id: roomId },
  });

  if (!room) {
    return sendError(user.ws, "Room not found");
  }

  if (room.creatorId !== user.userId) {
    return sendError(user.ws, "Only the room owner can rename the room");
  }

  // Check if new name is taken
  const existingRoom = await prisma.room.findUnique({
    where: { name: newName },
  });

  if (existingRoom && existingRoom.id !== roomId) {
    return sendError(user.ws, `Room name '${newName}' is already taken`);
  }

  // Update room
  const displayName = room.displayName.startsWith('#') ? `#${newName}` : newName;
  const updatedRoom = await prisma.room.update({
    where: { id: roomId },
    data: {
      name: newName,
      displayName,
    },
  });

  // Update active room cache
  const activeRoom = activeRooms.get(roomId);
  if (activeRoom) {
    activeRoom.name = newName;
    activeRoom.displayName = displayName;
  }

  // Broadcast update
  broadcastToRoom(roomId, {
    type: "roomRenamed",
    payload: {
      roomId,
      newName,
      displayName,
    },
  });

  console.log(`[ROOM] ${user.username} renamed room ${room.name} to ${newName}`);
}

async function handleDeleteRoom(user: ConnectedUser, payload: DeleteRoomPayload) {
  const { roomId } = payload;

  if (!roomId) {
    return sendError(user.ws, "Room ID is required");
  }

  // Find room and check ownership
  const room = await prisma.room.findUnique({
    where: { id: roomId },
  });

  if (!room) {
    return sendError(user.ws, "Room not found");
  }

  if (room.creatorId !== user.userId) {
    return sendError(user.ws, "Only the room owner can delete the room");
  }

  // Soft delete room
  await prisma.room.update({
    where: { id: roomId },
    data: { deletedAt: new Date() },
  });

  // Notify all users in the room
  broadcastToRoom(roomId, {
    type: "roomDeleted",
    payload: { roomId },
  });

  // Remove from active rooms cache
  activeRooms.delete(roomId);

  console.log(`[ROOM] ${user.username} deleted room ${room.name}`);
}

async function handleTransferOwnership(user: ConnectedUser, payload: TransferOwnershipPayload) {
  const { roomId, newOwnerUsername } = payload;

  if (!roomId || !newOwnerUsername) {
    return sendError(user.ws, "Room ID and new owner username are required");
  }

  // Find room and check ownership
  const room = await prisma.room.findUnique({
    where: { id: roomId },
  });

  if (!room) {
    return sendError(user.ws, "Room not found");
  }

  if (room.creatorId !== user.userId) {
    return sendError(user.ws, "Only the room owner can transfer ownership");
  }

  // Find target user
  const targetUser = await prisma.user.findUnique({
    where: { username: newOwnerUsername },
  });

  if (!targetUser) {
    return sendError(user.ws, "Target user not found");
  }

  // Update creatorId (which serves as owner)
  await prisma.room.update({
    where: { id: roomId },
    data: { creatorId: targetUser.id },
  });

  // Ensure target user is a member
  await prisma.roomMember.upsert({
    where: {
      roomId_userId: {
        roomId,
        userId: targetUser.id,
      },
    },
    create: {
      roomId,
      userId: targetUser.id,
    },
    update: {},
  });

  // Broadcast update
  broadcastToRoom(roomId, {
    type: "ownershipTransferred",
    payload: {
      roomId,
      newOwnerUsername: targetUser.username,
      newOwnerId: targetUser.id,
    },
  });

  console.log(`[ROOM] ${user.username} transferred ownership of ${room.name} to ${targetUser.username}`);
}

async function handleCreateDM(user: ConnectedUser, payload: CreateDMPayload) {
  const { targetUsername } = payload;

  if (!targetUsername) {
    return sendError(user.ws, "Target username is required");
  }

  if (targetUsername === user.username) {
    return sendError(user.ws, "You cannot DM yourself");
  }

  // Find target user
  const targetUser = await prisma.user.findUnique({
    where: { username: targetUsername },
  });

  if (!targetUser) {
    return sendError(user.ws, "Target user not found");
  }

  // Check for existing DM room
  // Find all DM rooms that current user is in
  const userDMs = await prisma.room.findMany({
    where: {
      roomType: 'dm',
      members: {
        some: { userId: user.userId },
      },
    },
    include: {
      members: {
        select: { userId: true },
      },
    },
  });

  // Check if any of these rooms also contain the target user
  let dmRoom = userDMs.find(room => 
    room.members.some(m => m.userId === targetUser.id)
  );

  if (!dmRoom) {
    // Create new DM room
    const name = `dm_${uuidv4()}`; // Internal unique name
    // Encrypted key for the room
    const encryptedKey = crypto.randomBytes(32).toString('hex');

    // Create room
    dmRoom = await prisma.room.create({
      data: {
        name,
        displayName: `${user.username}, ${targetUser.username}`, // Default display name
        roomType: 'dm',
        encryptedKey,
        creatorId: user.userId,
        members: {
          create: [
            { userId: user.userId },
            { userId: targetUser.id },
          ],
        },
      },
      include: {
        members: { select: { userId: true } },
      },
    });
    
    console.log(`[DM] Created new DM room between ${user.username} and ${targetUser.username}`);
  } else {
    console.log(`[DM] Found existing DM room between ${user.username} and ${targetUser.username}`);
  }

  // Now join the room (reuse logic)
  await handleJoinRoom(user, { roomId: dmRoom.id });
}

function handleVoiceSignal(user: ConnectedUser, payload: VoiceSignalPayload) {
  const { roomId, targetUserId, type, data } = payload;

  if (!roomId) return;

  const room = activeRooms.get(roomId);
  if (!room) return;

  // Initialize voice set if missing
  if (!room.voiceUsers) {
    room.voiceUsers = new Set();
  }

  // Handle Voice State Updates
  if (type === 'join_voice') {
    room.voiceUsers.add(user.userId);
    broadcastVoiceState(roomId);
    
    // Broadcast 'join_voice' signal to room so others initiate P2P
    const roomMembers = room.users.filter(roomUser => roomUser.userId !== user.userId);
    roomMembers.forEach(roomUser => {
      if (!room.voiceUsers?.has(roomUser.userId)) {
        return;
      }
      if (roomUser.ws.readyState !== WebSocket.OPEN) {
        return;
      }
      sendMessage(roomUser.ws, {
        type: "voiceSignal",
        payload: {
          roomId,
          senderUserId: user.userId,
          senderUsername: user.username,
          type,
          data: "",
        },
      });
    });

    console.log(`[VOICE] ${user.username} joined voice in room ${roomId}`);
    return;
  }

  if (type === 'leave_voice') {
    room.voiceUsers.delete(user.userId);
    broadcastVoiceState(roomId);
    
    const roomMembers = room.users.filter(roomUser => roomUser.userId !== user.userId);
    roomMembers.forEach(roomUser => {
      if (!room.voiceUsers?.has(roomUser.userId)) {
        return;
      }
      if (roomUser.ws.readyState !== WebSocket.OPEN) {
        return;
      }
      sendMessage(roomUser.ws, {
        type: "voiceSignal",
        payload: {
          roomId,
          senderUserId: user.userId,
          senderUsername: user.username,
          type,
          data: "",
        },
      });
    });
    
    console.log(`[VOICE] ${user.username} left voice in room ${roomId}`);
    return;
  }

  // Only allow voice signaling between users who joined voice
  if (!room.voiceUsers.has(user.userId)) {
    return;
  }

  // Handle P2P Signaling (Offer/Answer/Candidate)
  // If targetUserId is set, forward ONLY to that user
  if (targetUserId) {
    if (!room.voiceUsers.has(targetUserId)) {
      return;
    }
    const targetUser = room.users.find(u => u.userId === targetUserId);
    if (targetUser && targetUser.ws.readyState === WebSocket.OPEN) {
      sendMessage(targetUser.ws, {
        type: "voiceSignal",
        payload: {
          roomId,
          senderUserId: user.userId,
          senderUsername: user.username, // Helpful for UI
          type,
          data
        }
      });
      console.log(`[VOICE] Forwarded ${type} from ${user.username} to ${targetUser.username}`);
    }
  } else {
    // If no target, broadcast to all (rare for signaling, usually specific)
    // But maybe useful for initial discovery if 'join_voice' didn't suffice
  }
}

function broadcastVoiceState(roomId: string) {
  const room = activeRooms.get(roomId);
  if (!room || !room.voiceUsers) return;

  // Convert UserIDs to Usernames for UI display
  const activeUsernames = Array.from(room.voiceUsers).map(userId => {
    const u = room.users.find(u => u.userId === userId);
    return u ? u.username : "Unknown";
  });

  broadcastToRoom(roomId, {
    type: "voiceState",
    payload: {
      roomId,
      activeUsers: activeUsernames
    }
  });
}

async function handleCreateRoom(user: ConnectedUser, payload: CreateRoomPayload) {
  const { name, displayName, roomType } = payload;

  if (!name) {
    return sendError(user.ws, "Room name is required");
  }

  if (!roomType || (roomType !== 'public' && roomType !== 'private')) {
    return sendError(user.ws, "Room type must be 'public' or 'private'");
  }

  console.log(`[ROOM] ${user.username} creating ${roomType} room: ${name}`);

  // Check if room name already exists
  const existingRoom = await prisma.room.findUnique({
    where: { name },
  });

  if (existingRoom) {
    // If room exists and is NOT deleted, return error
    if (!existingRoom.deletedAt) {
      return sendError(user.ws, `Room name '${name}' already exists`);
    }
    
    // If room is deleted, rename it to free up the name
    // e.g. "general" -> "general_deleted_1678888888"
    await prisma.room.update({
      where: { id: existingRoom.id },
      data: {
        name: `${name}_deleted_${Date.now()}`,
      },
    });
    
    console.log(`[ROOM] Archived deleted room '${name}' to allow re-creation`);
  }

  // Generate encryption key for the room
  const encryptedKey = crypto.randomBytes(32).toString('hex');

  // Auto-generate display name if not provided
  const finalDisplayName = displayName || `#${name}`;

  // Create room in database
  const room = await prisma.room.create({
    data: {
      name,
      displayName: finalDisplayName,
      roomType,
      encryptedKey,
      creatorId: user.userId,
    },
  });

  // Add creator as member
  await prisma.roomMember.create({
    data: {
      roomId: room.id,
      userId: user.userId,
    },
  });

  // Send confirmation
  sendMessage(user.ws, {
    type: "roomCreated",
    payload: {
      roomId: room.id,
      roomName: room.name,
      displayName: room.displayName,
      roomType: room.roomType,
      encryptedKey: room.encryptedKey || '',
    },
  });

  console.log(`[ROOM] ${roomType} room created: ${room.displayName} (${room.id}) by ${user.username}`);
}

async function handleListRooms(user: ConnectedUser, payload: ListRoomsPayload) {
  console.log(`[ROOM] ${user.username} requesting room list`);

  // Get all public rooms
  const publicRooms = await prisma.room.findMany({
    where: {
      roomType: 'public',
      deletedAt: null,
    },
    include: {
      _count: {
        select: { members: true },
      },
      members: {
        where: { userId: user.userId },
      },
    },
  });

  // Get user's private rooms (only ones they're a member of)
  const privateRooms = await prisma.room.findMany({
    where: {
      roomType: { in: ['private', 'dm'] },
      deletedAt: null,
      members: {
        some: { userId: user.userId },
      },
    },
    include: {
      _count: {
        select: { members: true },
      },
      members: {
        where: { userId: user.userId },
      },
    },
  });

  // Format room info
  const formatRoom = (room: any) => ({
    roomId: room.id,
    name: room.name,
    displayName: room.displayName,
    roomType: room.roomType,
    memberCount: room._count.members,
    isJoined: room.members.length > 0,
  });

  sendMessage(user.ws, {
    type: "roomsList",
    payload: {
      publicRooms: publicRooms.map(formatRoom),
      privateRooms: privateRooms.map(formatRoom),
    },
  });

  console.log(`[ROOM] Sent room list to ${user.username}: ${publicRooms.length} public, ${privateRooms.length} private`);
}

async function handleLeaveRoom(user: ConnectedUser, payload: LeaveRoomPayload) {
  const { roomId } = payload;

  if (!roomId) {
    return;
  }

  console.log(`[ROOM] ${user.username} leaving room ${roomId}`);

  // Remove from active room
  const activeRoom = activeRooms.get(roomId);
  if (activeRoom) {
    // Bug 3 fix: clean up voiceUsers and notify remaining voice users
    if (activeRoom.voiceUsers?.has(user.userId)) {
      activeRoom.voiceUsers.delete(user.userId);
      broadcastVoiceState(roomId);

      // Broadcast leave_voice to remaining voice users so they close the peer connection
      const voiceMembers = activeRoom.users.filter(
        roomUser => roomUser.userId !== user.userId && activeRoom.voiceUsers?.has(roomUser.userId)
      );
      voiceMembers.forEach(roomUser => {
        if (roomUser.ws.readyState !== WebSocket.OPEN) return;
        sendMessage(roomUser.ws, {
          type: "voiceSignal",
          payload: {
            roomId,
            senderUserId: user.userId,
            senderUsername: user.username,
            type: "leave_voice",
            data: "",
          },
        });
      });
      console.log(`[VOICE] ${user.username} removed from voice in room ${roomId} (room leave)`);
    }

    activeRoom.users = activeRoom.users.filter(u => u.userId !== user.userId);

    // Broadcast user left
    broadcastToRoom(roomId, {
      type: "userLeft",
      payload: {
        username: user.username,
        userId: user.userId,
      },
    });

    // Remove active room if empty
    if (activeRoom.users.length === 0) {
      activeRooms.delete(roomId);
      console.log(`[ROOM] Active room ${roomId} removed (no users)`);
    }
  }

  user.currentRoomId = null;
}

function handleDisconnect(user: ConnectedUser) {
  if (user.currentRoomId) {
    handleLeaveRoom(user, { roomId: user.currentRoomId });
  }
}

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

function sendMessage(ws: WebSocket, message: ServerMessage) {
  if (ws.readyState === WebSocket.OPEN) {
    const json = JSON.stringify(message);
    console.log(`[WS] → Sending:`, json);
    ws.send(json);
  }
}

function sendError(ws: WebSocket, message: string) {
  sendMessage(ws, {
    type: "error",
    payload: { message },
  });
}

function broadcastToRoom(roomId: string, message: ServerMessage, excludeWs?: WebSocket) {
  const room = activeRooms.get(roomId);
  if (!room) return;

  const json = JSON.stringify(message);
  console.log(`[BROADCAST] To room ${roomId}:`, json);

  room.users.forEach(user => {
    if (user.ws !== excludeWs && user.ws.readyState === WebSocket.OPEN) {
      user.ws.send(json);
    }
  });
}

// ============================================================================
// START SERVER
// ============================================================================

httpServer.listen(PORT, HOST, () => {
  console.log(`✅ HTTP API listening on http://${HOST}:${PORT}`);
  console.log(`✅ WebSocket server listening on ws://${HOST}:${PORT}/ws`);
  console.log(`📊 Health check available at http://${HOST}:${PORT}/health`);
  console.log("=====================================================");
});

// ============================================================================
// GRACEFUL SHUTDOWN
// ============================================================================

async function shutdown() {
  console.log('\n🛑 Shutting down server...');
  
  // Close all WebSocket connections gracefully
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.close(1001, 'Server shutting down');
    }
  });

  wss.close(() => {
    console.log('✅ WebSocket server closed');
  });

  httpServer.close(() => {
    console.log('✅ HTTP server closed');
  });

  await prisma.$disconnect();
  console.log('✅ Database disconnected');
  
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
