// src/index.ts
import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import multer from 'multer';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
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
import { documentsController } from './controllers/documents.controller';
import { processVoiceMemo } from './services/voicememo.service';
import kundeRoutes from './routes/kunde.routes';
import jeffreyOcrRoutes from './routes/jeffrey-ocr.routes';
import trackingRoutes from './routes/tracking.routes';
import emailRoutes from './routes/email.routes';
import voiceAgentRoutes from './routes/voiceAgent.routes';
import signatureRoutes, { publicSignatureRouter } from './routes/signature.routes';
import secureLinkRoutes from './routes/secureLink.routes';
import stellungnahmeRoutes from './routes/stellungnahme.routes';

// Load environment variables
dotenv.config();

const app = express();
const PORT = process.env.PORT || 4000;

// Multer for file uploads (memory storage)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }, // 25MB max
});

// ── Security Middleware ──
app.use(helmet({
  contentSecurityPolicy: false,   // CSP handled by frontend (Vercel)
  crossOriginEmbedderPolicy: false,
}));

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

// ── Rate Limiting ──
// Global: 1500 requests per 15 minutes per IP (each page load triggers ~6 API calls)
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 1500,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Zu viele Anfragen. Bitte später erneut versuchen.' },
});
app.use(globalLimiter);

// Strict: Login — 5 attempts per 15 minutes per IP
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Zu viele Login-Versuche. Bitte in 15 Minuten erneut versuchen.' },
});

// Public form submit — 100 per 15 minutes per IP (raised for paid ads campaigns)
const funnelLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Zu viele Anfragen. Bitte später erneut versuchen.' },
});

// Strict: SecureLink validate — 10 attempts per 15 minutes (brute-force protection)
const secureLinkLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Zu viele Versuche. Bitte warten Sie 15 Minuten.' },
});

// Webhook: 30 per minute per IP (n8n, SendGrid)
const webhookLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Rate limit exceeded' },
});

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
    version: 'v6-security',
  });
});

// ── Public routes (rate-limited, no auth) ──

// Auth routes — login has strict rate limit
app.use('/api/auth/login', authLimiter);
app.use('/api/auth', authRoutes);

// Document webhooks ONLY (public — n8n, SendGrid inbound)
const webhookUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });
app.post('/api/documents/inbound', webhookLimiter, webhookUpload.any(), (req, res) => documentsController.inboundWebhook(req, res));
app.post('/api/documents/n8n-upload', webhookLimiter, (req, res) => documentsController.n8nUpload(req, res));

// OnePage Funnel — public lead form
app.post('/api/leads/onepage-funnel', funnelLimiter, (req, res) => leadsController.onepageFunnel(req, res));

// Jeffrey checklist/reminder routes (public for now)
app.use('/api/jeffrey', jeffreyRoutes);

// Email tracking pixel (public — loaded by recipient's email client)
app.use('/api/tracking', trackingRoutes);

// Voice Agent routes (webhook is public, /call requires auth — handled in router)
app.use('/api/voice-agent', voiceAgentRoutes);

// Secure document link (validate + documents public, /create requires auth — handled in router)
app.use('/api/secure-link/validate', secureLinkLimiter);
app.use('/api/secure-link', secureLinkRoutes);

// Public signature routes (verify + sign via token — no auth required)
app.use('/api/signature-public', publicSignatureRouter);

// ── Protected API Routes (require JWT) ──

// Documents — protected (except webhooks above)
app.use('/api/documents', authMiddleware, documentsRoutes);

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
app.use('/api/stellungnahme', authMiddleware, stellungnahmeRoutes);

// Google Drive connection check
app.get('/api/gdrive/check', authMiddleware, async (req, res) => {
  try {
    const { checkConnection, resetClient } = await import('./services/googleDrive.service');

    // Reset cached client to force fresh OAuth2 token exchange
    resetClient();

    const envStatus = {
      clientId: !!process.env.GOOGLE_DRIVE_CLIENT_ID,
      clientSecret: !!process.env.GOOGLE_DRIVE_CLIENT_SECRET,
      refreshToken: !!process.env.GOOGLE_DRIVE_REFRESH_TOKEN,
      refreshTokenPreview: process.env.GOOGLE_DRIVE_REFRESH_TOKEN
        ? `${process.env.GOOGLE_DRIVE_REFRESH_TOKEN.substring(0, 10)}...${process.env.GOOGLE_DRIVE_REFRESH_TOKEN.substring(process.env.GOOGLE_DRIVE_REFRESH_TOKEN.length - 6)}`
        : '(not set)',
      folderId: process.env.GOOGLE_DRIVE_FOLDER_ID || '(not set)',
    };

    const ok = await checkConnection();
    res.json({ connected: ok, env: envStatus });
  } catch (err: any) {
    res.json({ connected: false, error: err.message, stack: err.stack?.split('\n').slice(0, 3) });
  }
});

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