// src/routes/auth.routes.ts
import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { PrismaClient } from '@prisma/client';
import { authMiddleware, AuthRequest } from '../middleware/auth.middleware';

const router = Router();
const prisma = new PrismaClient();

const JWT_SECRET = process.env.JWT_SECRET || 'dev-only-secret-not-for-production';

// ============================================================
// Seed-Daten: Werden beim ersten Start in die DB geschrieben
// ============================================================
const SEED_USERS = [
  {
    name: 'Roland Potlog',
    email: 'roland@immo-kredit.net',
    role: 'ADMIN' as const,
    passwordHash: '$2b$10$RRPHQiL4KDdtLqKYuJfUx.PnxcubYvBFehc1/esLPhzySebhq5ppS',
  },
  {
    name: 'Slaven Pavic',
    email: 'slaven@immo-kredit.net',
    role: 'AGENT' as const,
    passwordHash: '$2b$10$7n/OnItgBs/a7J33vigQ..LBIKxephIaB5PhOt3sFvZY7.bl987pm',
  },
  {
    name: 'Daniel Tunjic',
    email: 'daniel@immo-kredit.net',
    role: 'AGENT' as const,
    passwordHash: '$2b$10$6wk4I.8zX0DE99rq2n56KuY40sjzqSyH5rXxi3zC4oqrICIhJ5MKC',
  },
];

// ============================================================
// User-Seeding: Erstellt DB-User falls noch nicht vorhanden
// ============================================================
export async function ensureUsersExist() {
  for (const seed of SEED_USERS) {
    const existing = await prisma.user.findUnique({ where: { email: seed.email } });
    if (!existing) {
      await prisma.user.create({
        data: {
          email: seed.email,
          name: seed.name,
          password: seed.passwordHash,
          role: seed.role,
        },
      });
      console.log(`[Auth] Seeded user: ${seed.name} (${seed.email})`);
    }
  }
}

// ============================================================
// POST /api/auth/login
// ============================================================
router.post('/login', async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email und Passwort erforderlich' });
    }

    // Look up user in database
    const user = await prisma.user.findUnique({
      where: { email: email.toLowerCase() },
    });

    if (!user) {
      return res.status(401).json({ error: 'Ungültige Anmeldedaten' });
    }

    const isValid = await bcrypt.compare(password, user.password);
    if (!isValid) {
      return res.status(401).json({ error: 'Ungültige Anmeldedaten' });
    }

    const token = jwt.sign(
      { id: user.id, email: user.email, name: user.name, role: user.role },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    console.log(`[Auth] Login: ${user.name} (${user.email})`);

    res.json({
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role.toLowerCase(),
      },
    });
  } catch (error: any) {
    console.error('[Auth] Login error:', error.message);
    res.status(500).json({ error: 'Login fehlgeschlagen' });
  }
});

// ============================================================
// GET /api/auth/me — Aktuellen User abrufen
// ============================================================
router.get('/me', async (req: Request, res: Response) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Nicht authentifiziert' });
    }

    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, JWT_SECRET) as any;

    const user = await prisma.user.findUnique({ where: { id: decoded.id } });
    if (!user) {
      return res.status(401).json({ error: 'Benutzer nicht gefunden' });
    }

    res.json({
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role.toLowerCase(),
      senderEmail: user.senderEmail || null,
      senderName: user.senderName || null,
    });
  } catch (error: any) {
    res.status(401).json({ error: 'Token ungültig oder abgelaufen' });
  }
});

// ============================================================
// PUT /api/auth/profile — Name aktualisieren
// ============================================================
router.put('/profile', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'Nicht authentifiziert' });

    const { name, senderEmail, senderName } = req.body;
    if (!name || name.trim().length < 2) {
      return res.status(400).json({ error: 'Name muss mindestens 2 Zeichen lang sein' });
    }

    const updateData: any = { name: name.trim() };
    if (senderEmail !== undefined) updateData.senderEmail = senderEmail?.trim() || null;
    if (senderName !== undefined) updateData.senderName = senderName?.trim() || null;

    const updated = await prisma.user.update({
      where: { id: userId },
      data: updateData,
    });

    console.log(`[Auth] Profile updated: ${updated.name} (${updated.email})${updated.senderEmail ? ` [sender: ${updated.senderEmail}]` : ''}`);

    res.json({
      success: true,
      user: {
        id: updated.id,
        name: updated.name,
        email: updated.email,
        role: updated.role.toLowerCase(),
        senderEmail: updated.senderEmail || null,
        senderName: updated.senderName || null,
      },
    });
  } catch (error: any) {
    console.error('[Auth] Profile update error:', error.message);
    res.status(500).json({ error: 'Profil konnte nicht aktualisiert werden' });
  }
});

// ============================================================
// PUT /api/auth/password — Passwort ändern
// ============================================================
router.put('/password', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'Nicht authentifiziert' });

    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: 'Aktuelles und neues Passwort erforderlich' });
    }

    if (newPassword.length < 6) {
      return res.status(400).json({ error: 'Neues Passwort muss mindestens 6 Zeichen lang sein' });
    }

    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      return res.status(404).json({ error: 'Benutzer nicht gefunden' });
    }

    // Verify current password
    const isValid = await bcrypt.compare(currentPassword, user.password);
    if (!isValid) {
      return res.status(400).json({ error: 'Aktuelles Passwort ist falsch' });
    }

    // Hash new password and save
    const newHash = await bcrypt.hash(newPassword, 10);
    await prisma.user.update({
      where: { id: userId },
      data: { password: newHash },
    });

    console.log(`[Auth] Password changed: ${user.name} (${user.email})`);

    res.json({ success: true, message: 'Passwort erfolgreich geändert' });
  } catch (error: any) {
    console.error('[Auth] Password change error:', error.message);
    res.status(500).json({ error: 'Passwort konnte nicht geändert werden' });
  }
});

// ============================================================
// PUT /api/auth/notification-prefs — Benachrichtigungseinstellungen
// ============================================================
router.put('/notification-prefs', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'Nicht authentifiziert' });

    const prefs = req.body;

    // Validate: only accept known keys
    const allowedKeys = [
      'neuerLead', 'dokumentHochgeladen', 'emailGeoeffnet',
      'pipelineAenderung', 'tagesReport', 'wochenReport', 'systemUpdates',
    ];

    const sanitized: Record<string, boolean> = {};
    for (const key of allowedKeys) {
      if (typeof prefs[key] === 'boolean') {
        sanitized[key] = prefs[key];
      }
    }

    await prisma.user.update({
      where: { id: userId },
      data: { notificationPrefs: sanitized },
    });

    console.log(`[Auth] Notification prefs updated for user ${userId}`);

    res.json({ success: true, prefs: sanitized });
  } catch (error: any) {
    console.error('[Auth] Notification prefs error:', error.message);
    res.status(500).json({ error: 'Einstellungen konnten nicht gespeichert werden' });
  }
});

// ============================================================
// GET /api/auth/team — Alle Team-Mitglieder auflisten
// ============================================================
router.get('/team', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const users = await prisma.user.findMany({
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'asc' },
    });

    const team = users.map((u) => ({
      id: u.id,
      name: u.name,
      email: u.email,
      role: u.role.toLowerCase(),
      createdAt: u.createdAt,
    }));

    res.json(team);
  } catch (error: any) {
    console.error('[Auth] Team list error:', error.message);
    res.status(500).json({ error: 'Team konnte nicht geladen werden' });
  }
});

export default router;
