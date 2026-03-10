// src/middleware/auth.middleware.ts
import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.error('[SECURITY] JWT_SECRET ist nicht gesetzt! Server kann keine Tokens validieren.');
  if (process.env.NODE_ENV === 'production') {
    throw new Error('JWT_SECRET muss in Production gesetzt sein');
  }
}
const JWT_SECRET_VALUE = JWT_SECRET || 'dev-only-secret-not-for-production';

export interface AuthRequest extends Request {
  user?: {
    id: string;
    email: string;
    name: string;
    role: string;
  };
}

export function authMiddleware(req: AuthRequest, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Nicht authentifiziert' });
  }

  try {
    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, JWT_SECRET_VALUE) as any;
    req.user = {
      id: decoded.id,
      email: decoded.email,
      name: decoded.name,
      role: decoded.role,
    };
    next();
  } catch (error) {
    return res.status(401).json({ error: 'Token ungültig oder abgelaufen' });
  }
}