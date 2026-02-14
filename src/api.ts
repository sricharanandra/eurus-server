import express, { Request, Response } from 'express';
import cors from 'cors';
import { registerUser, createChallenge, verifySignature, simpleLogin, verifyToken, generateToken } from './auth';
import { prisma } from './database';
import { RegisterRequest, ChallengeRequest, VerifyRequest } from './types';

const app = express();

// Middleware
app.use(cors());
app.use(express.json());

// ============================================================================
// AUTHENTICATION ENDPOINTS
// ============================================================================

// Register new user
app.post('/api/auth/register', async (req: Request, res: Response) => {
  try {
    const request: RegisterRequest = req.body;
    
    if (!request.username || !request.publicKey || !request.keyType) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const response = await registerUser(request);
    res.json(response);
  } catch (error: any) {
    console.error('[API] Registration error:', error);
    res.status(400).json({ error: error.message });
  }
});

// Get authentication challenge
app.post('/api/auth/challenge', async (req: Request, res: Response) => {
  try {
    const { username }: ChallengeRequest = req.body;
    
    if (!username) {
      return res.status(400).json({ error: 'Username required' });
    }

    const response = await createChallenge(username);
    res.json(response);
  } catch (error: any) {
    console.error('[API] Challenge error:', error);
    res.status(400).json({ error: error.message });
  }
});

// Verify signature and login
app.post('/api/auth/verify', async (req: Request, res: Response) => {
  try {
    const { username, signature, publicKey }: VerifyRequest = req.body;
    
    if (!username || !signature || !publicKey) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const response = await verifySignature(username, signature, publicKey);
    res.json(response);
  } catch (error: any) {
    console.error('[API] Verification error:', error);
    res.status(401).json({ error: error.message });
  }
});

// Simplified login (for development)
app.post('/api/auth/login', async (req: Request, res: Response) => {
  try {
    const { username } = req.body;
    
    if (!username) {
      return res.status(400).json({ error: 'Username required' });
    }

    const response = await simpleLogin(username);
    res.json(response);
  } catch (error: any) {
    console.error('[API] Login error:', error);
    res.status(400).json({ error: error.message });
  }
});

// Check if user exists
app.get('/api/auth/exists/:username', async (req: Request, res: Response) => {
  try {
    const username = req.params.username as string;
    
    if (!username) {
      return res.status(400).json({ error: 'Username required' });
    }

    const user = await prisma.user.findUnique({
      where: { username },
      select: {
        publicKeyEd25519: true,
        publicKeyRsa: true,
      },
    });

    if (!user) {
      return res.json({ exists: false });
    }

    // Determine key type
    let keyType: string | null = null;
    if (user.publicKeyEd25519) {
      keyType = 'ed25519';
    } else if (user.publicKeyRsa) {
      keyType = 'rsa';
    }

    res.json({ exists: true, keyType });
  } catch (error: any) {
    console.error('[API] User exists check error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Refresh token (requires valid token in Authorization header)
app.post('/api/auth/refresh', async (req: Request, res: Response) => {
  try {
    const authHeader = req.headers.authorization;
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'No token provided' });
    }

    const token = authHeader.substring(7); // Remove 'Bearer ' prefix
    const payload = verifyToken(token);
    
    if (!payload) {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }

    // Verify user still exists
    const user = await prisma.user.findUnique({
      where: { id: payload.userId },
    });

    if (!user) {
      return res.status(401).json({ error: 'User not found' });
    }

    // Update last seen
    await prisma.user.update({
      where: { id: user.id },
      data: { lastSeen: new Date() },
    });

    // Generate new token with fresh expiry
    const newToken = generateToken(user.id, user.username);
    
    console.log(`[AUTH] Token refreshed for user: ${user.username}`);
    
    res.json({ token: newToken });
  } catch (error: any) {
    console.error('[API] Token refresh error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================================================
// ROOM ENDPOINTS
// ============================================================================

// Get rooms list (public + user's private rooms)
app.get('/api/rooms', async (req: Request, res: Response) => {
  try {
    // TODO: Add auth middleware to get userId from token
    // For now, return all public rooms and sample of private
    
    const roomType = req.query.type as string | undefined;
    
    const where: any = { deletedAt: null };
    if (roomType === 'public' || roomType === 'private') {
      where.roomType = roomType;
    }

    const rooms = await prisma.room.findMany({
      where,
      include: {
        creator: {
          select: { username: true },
        },
        _count: {
          select: { members: true },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    const formattedRooms = rooms.map(room => ({
      roomId: room.id,
      name: room.name,
      displayName: room.displayName,
      roomType: room.roomType,
      creator: room.creator.username,
      memberCount: room._count.members,
      createdAt: room.createdAt.toISOString(),
    }));

    res.json(formattedRooms);
  } catch (error: any) {
    console.error('[API] Get rooms error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get room messages with cursor-based pagination
app.get('/api/rooms/:roomId/messages', async (req: Request, res: Response) => {
  try {
    const roomId = req.params.roomId as string;
    const limitQuery = req.query.limit;
    const before = req.query.before as string | undefined; // Message ID cursor
    const limit = (typeof limitQuery === 'string') ? Math.min(parseInt(limitQuery), 100) : 50;

    const where: any = { roomId };
    
    // Cursor-based pagination: fetch messages before this ID
    if (before) {
      where.id = { lt: before };
    }

    const messages = await prisma.message.findMany({
      where,
      include: {
        sender: {
          select: { username: true },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: limit + 1, // Fetch one extra to check if there are more
    });

    const hasMore = messages.length > limit;
    const messagesToReturn = hasMore ? messages.slice(0, limit) : messages;

    // Reverse to get chronological order
    const formattedMessages = messagesToReturn.reverse().map(m => ({
      id: m.id,
      username: m.sender.username,
      ciphertext: m.ciphertext,
      messageType: m.messageType,
      imageUrl: m.imageUrl || undefined,
      timestamp: m.createdAt.toISOString(),
    }));

    res.json({
      messages: formattedMessages,
      hasMore,
    });
  } catch (error: any) {
    console.error('[API] Get messages error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Health check
app.get('/health', (req: Request, res: Response) => {
  res.json({ 
    status: 'ok',
    environment: process.env.NODE_ENV || 'development',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
});

export default app;
