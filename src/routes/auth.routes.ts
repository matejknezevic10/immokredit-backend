// src/routes/auth.routes.ts
import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

const router = Router();

const JWT_SECRET = process.env.JWT_SECRET || 'immokredit-secret-key-change-in-production';

// Hardcoded users (simple for 3 users)
const USERS = [
  {
    id: '1',
    name: 'Roland Potlog',
    email: 'roland@immo-kredit.net',
    role: 'admin',
    passwordHash: '$2b$10$RRPHQiL4KDdtLqKYuJfUx.PnxcubYvBFehc1/esLPhzySebhq5ppS',
  },
  {
    id: '2',
    name: 'Slaven Pavic',
    email: 'slaven@immo-kredit.net',
    role: 'user',
    passwordHash: '$2b$10$7n/OnItgBs/a7J33vigQ..LBIKxephIaB5PhOt3sFvZY7.bl987pm',
  },
  {
    id: '3',
    name: 'Daniel Tunjic',
    email: 'daniel@immo-kredit.net',
    role: 'user',
    passwordHash: '$2b$10$6wk4I.8zX0DE99rq2n56KuY40sjzqSyH5rXxi3zC4oqrICIhJ5MKC',
  },
];

// POST /api/auth/login
router.post('/login', async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email und Passwort erforderlich' });
    }

    const user = USERS.find((u) => u.email.toLowerCase() === email.toLowerCase());
    if (!user) {
      return res.status(401).json({ error: 'Ungültige Anmeldedaten' });
    }

    const isValid = await bcrypt.compare(password, user.passwordHash);
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
        role: user.role,
      },
    });
  } catch (error: any) {
    console.error('[Auth] Login error:', error.message);
    res.status(500).json({ error: 'Login fehlgeschlagen' });
  }
});

// GET /api/auth/me - Get current user from token
router.get('/me', (req: Request, res: Response) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Nicht authentifiziert' });
    }

    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, JWT_SECRET) as any;

    const user = USERS.find((u) => u.id === decoded.id);
    if (!user) {
      return res.status(401).json({ error: 'Benutzer nicht gefunden' });
    }

    res.json({
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
    });
  } catch (error: any) {
    res.status(401).json({ error: 'Token ungültig oder abgelaufen' });
  }
});

export default router;