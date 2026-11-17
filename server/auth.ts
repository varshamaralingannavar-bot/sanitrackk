import crypto from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { db } from './db.ts';

export type UserRole = 'citizen' | 'worker' | 'inspector' | 'admin';

export interface AuthUser {
  id: string;
  name: string;
  email: string;
  phone: string;
  role: UserRole;
  ward_number: number | null;
  assigned_wards: number[];
  language_pref: string;
  is_demo: boolean;
}

export interface AuthedRequest extends Request {
  user?: AuthUser;
}

const TOKEN_SECRET = process.env.SESSION_SECRET || 'sanitrack-belagavi-session-secret-2026';

export function signToken(userId: string, role: UserRole): string {
  const payload = Buffer.from(
    JSON.stringify({
      uid: userId,
      role,
      exp: Date.now() + 1000 * 60 * 60 * 24 * 7,
    })
  ).toString('base64url');
  const sig = crypto.createHmac('sha256', TOKEN_SECRET).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

export function verifyToken(token: string): { uid: string; role: UserRole } | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 2) return null;
    const [payload, sig] = parts;
    const expected = crypto.createHmac('sha256', TOKEN_SECRET).update(payload).digest('base64url');
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!parsed.uid || !parsed.exp || parsed.exp < Date.now()) return null;
    return { uid: parsed.uid, role: parsed.role };
  } catch {
    return null;
  }
}

export function loadUserById(userId: string): AuthUser | null {
  const row = db.prepare(`
    SELECT id, name, email, phone, role, ward_number, assigned_wards_json, language_pref, is_active, is_demo
    FROM profiles WHERE id = ?
  `).get(userId) as {
    id: string;
    name: string;
    email: string;
    phone: string;
    role: UserRole;
    ward_number: number | null;
    assigned_wards_json: string;
    language_pref: string;
    is_active: number;
    is_demo: number;
  } | undefined;

  if (!row || row.is_active !== 1) return null;
  let assigned_wards: number[] = [];
  try {
    assigned_wards = JSON.parse(row.assigned_wards_json || '[]');
  } catch {
    assigned_wards = [];
  }

  return {
    id: row.id,
    name: row.name,
    email: row.email,
    phone: row.phone,
    role: row.role,
    ward_number: row.ward_number,
    assigned_wards,
    language_pref: row.language_pref || 'en',
    is_demo: row.is_demo === 1,
  };
}

export function optionalAuth(req: AuthedRequest, _res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    const verified = verifyToken(token);
    if (verified) {
      const user = loadUserById(verified.uid);
      if (user) req.user = user;
    }
  }
  next();
}

export function requireAuth(req: AuthedRequest, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Authentication required.' });
    return;
  }
  const token = authHeader.slice(7);
  const verified = verifyToken(token);
  if (!verified) {
    res.status(401).json({ error: 'Session expired or invalid token.' });
    return;
  }
  const user = loadUserById(verified.uid);
  if (!user) {
    res.status(401).json({ error: 'Account is inactive or not found.' });
    return;
  }
  req.user = user;
  next();
}

export function requireRole(...roles: UserRole[]) {
  return (req: AuthedRequest, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({ error: 'Authentication required.' });
      return;
    }
    if (!roles.includes(req.user.role)) {
      res.status(403).json({ error: `Access denied. Required role: ${roles.join(' or ')}.` });
      return;
    }
    next();
  };
}
