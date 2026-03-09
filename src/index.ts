// src/index.ts
import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import multer from 'multer';
import authRoutes, { ensureUsersExist } from './routes/auth.routes';
import leadsRoutes from './routes/leads.routes';
import dealsRoutes from './routes/deals.routes';
import statsRoutes from './routes/stats.routes';
import documentsRoutes from './routes/documents.routes';
import pipedriveRoutes from './routes/pipedrive.routes';
import chatRoutes from './routes/chat.routes';
import { authMiddleware } from './middleware/auth.middleware';
import jeffreyRoutes from './routes/jeffrey.routes';
import { leadsController } from './controllers/leads.controller';
import { processVoiceMemo } from './services/voicememo.service';
import kundeRoutes from './routes/kunde.routes';
import jeffreyOcrRoutes from './routes/jeffrey-ocr.routes';
import trackingRoutes from './routes/tracking.routes';
import emailRoutes from './routes/email.routes';
import voiceAgentRoutes from './routes/voiceAgent.routes';
import signatureRoutes from './routes/signature.routes';
import secureLinkRoutes from './routes/secureLink.routes';

// Load environment variables
dotenv.config();

const app = express();
const PORT = process.env.PORT || 4000;

// Multer for file uploads (memory storage)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }, // 25MB max
});

// Middleware
app.use(cors({
  origin: [
    process.env.FRONTEND_URL || 'http://localhost:3000',
    'https://immokredit-frontend.vercel.app',
    'https://immo-kredit.net',
    'https://www.immo-kredit.net',
  ],
  credentials: true,
}));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Request logging
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
  next();
});

// Health check (public)
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV,
    version: 'v4-autocreate',
  });
});

// Temporary diagnostic endpoint (public) — REMOVE AFTER DEBUGGING
app.get('/debug/pipeline-enrichment', async (req, res) => {
  try {
    const { PrismaClient } = require('@prisma/client');
    const debugPrisma = new PrismaClient();

    const PIPEDRIVE_API_TOKEN = process.env.PIPEDRIVE_API_TOKEN || '';
    const PIPEDRIVE_BASE_URL = process.env.PIPEDRIVE_BASE_URL || 'https://api.pipedrive.com/v1';

    // Fetch deals from Pipedrive
    const pdResponse = await fetch(`${PIPEDRIVE_BASE_URL}/deals?status=open&limit=10&api_token=${PIPEDRIVE_API_TOKEN}`);
    const pdData = await pdResponse.json() as any;
    const pdDeals = (pdData.data || []).slice(0, 5);

    const dealSummary = pdDeals.map((d: any) => ({
      id: d.id,
      title: d.title,
      personName: d.person_id?.name || null,
      personEmail: d.person_id?.email?.[0]?.value || null,
      person_id_type: typeof d.person_id,
    }));

    const pdIds = pdDeals.map((d: any) => d.id);

    // Check local DB
    const localDeals = await debugPrisma.deal.findMany({
      where: { pipedriveDealId: { in: pdIds } },
      select: { pipedriveDealId: true, leadId: true },
    });

    const localLeads = await debugPrisma.lead.findMany({
      where: { pipedriveDealId: { in: pdIds } },
      select: { pipedriveDealId: true, id: true },
    });

    // Count all records
    const totalDeals = await debugPrisma.deal.count();
    const totalLeads = await debugPrisma.lead.count();
    const dealsWithPdId = await debugPrisma.deal.findMany({
      select: { pipedriveDealId: true },
      take: 20,
    });
    const leadsWithPdId = await debugPrisma.lead.findMany({
      where: { pipedriveDealId: { not: null } },
      select: { pipedriveDealId: true, id: true },
      take: 20,
    });

    await debugPrisma.$disconnect();

    res.json({
      pipedriveDeals: dealSummary,
      pipedriveIds: pdIds,
      localDealsMatched: localDeals,
      localLeadsMatched: localLeads,
      dbStats: {
        totalDeals,
        totalLeads,
        dealPipedriveDealIds: dealsWithPdId.map((d: any) => d.pipedriveDealId),
        leadPipedriveDealIds: leadsWithPdId.map((l: any) => ({ pdId: l.pipedriveDealId, leadId: l.id })),
      },
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message, stack: err.stack });
  }
});

// Auth routes (public)
app.use('/api/auth', authRoutes);

// Document inbound from n8n (public - no auth needed)
app.use('/api/documents', documentsRoutes);

// ── Public routes (no auth) ──
// OnePage Funnel — must be BEFORE authMiddleware
app.post('/api/leads/onepage-funnel', (req, res) => leadsController.onepageFunnel(req, res));

// Jeffrey checklist/reminder routes (public for now)
app.use('/api/jeffrey', jeffreyRoutes);

// Email tracking pixel (public — loaded by recipient's email client)
app.use('/api/tracking', trackingRoutes);

// Voice Agent routes (webhook is public, /call requires auth — handled in router)
app.use('/api/voice-agent', voiceAgentRoutes);

// Secure document link (validate + documents public, /create requires auth — handled in router)
app.use('/api/secure-link', secureLinkRoutes);

// ── Protected API Routes (require JWT) ──

// Voice Memo — requires auth (user must be logged in)
app.post('/api/leads/voice-memo', authMiddleware, upload.single('audio'), async (req: any, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Keine Audiodatei empfangen' });
    }
    console.log(`[VoiceMemo] Received audio: ${req.file.originalname}, ${req.file.size} bytes, ${req.file.mimetype}`);
    const result = await processVoiceMemo(req.file.buffer, req.file.mimetype);
    res.json(result);
  } catch (err: any) {
    console.error('[VoiceMemo] Error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.use('/api/leads', authMiddleware, leadsRoutes);
app.use('/api/deals', authMiddleware, dealsRoutes);
app.use('/api/stats', authMiddleware, statsRoutes);
app.use('/api/pipedrive', authMiddleware, pipedriveRoutes);
app.use('/api/chat', authMiddleware, chatRoutes);
app.use('/api/kunde', authMiddleware, kundeRoutes);
app.use('/api/jeffrey-ocr', authMiddleware, jeffreyOcrRoutes);
app.use('/api/email', authMiddleware, emailRoutes);
app.use('/api/signature', authMiddleware, signatureRoutes);

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    error: 'Not Found',
    message: `Route ${req.method} ${req.path} not found`,
  });
});

// Error handler
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error('Error:', err);
  res.status(err.status || 500).json({
    error: err.message || 'Internal Server Error',
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack }),
  });
});

// Start server
app.listen(PORT, async () => {
  // Ensure seed users exist in database
  try {
    await ensureUsersExist();
    console.log('[Auth] User seeding complete');
  } catch (err: any) {
    console.error('[Auth] User seeding failed:', err.message);
  }

  console.log(`
🚀 ImmoKredit Backend API Server

📡 Server running on: http://localhost:${PORT}
🏥 Health check: http://localhost:${PORT}/health
🌍 Environment: ${process.env.NODE_ENV || 'development'}
🔐 Auth: POST /api/auth/login, GET /api/auth/me
  `);
});

export default app;