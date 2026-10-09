import { createHash, randomBytes, scryptSync } from 'node:crypto';

export function hashToken(value: string) {
  return createHash('sha256').update(value).digest('hex');
}

export function generateToken(prefix: string) {
  return `${prefix}_${randomBytes(24).toString('hex')}`;
}

export function hashPassword(password: string) {
  const salt = randomBytes(16).toString('hex');
  const derived = scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${derived}`;
}
