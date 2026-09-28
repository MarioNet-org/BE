import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { z } from 'zod';

const scrypt = promisify(scryptCallback);
export const passwordSchema = z.string().min(12).max(128);
export const emailSchema = z.email().max(254).transform(value => value.toLowerCase());
export const tokenSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const newToken = () => randomBytes(32).toString('hex');
export const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export const after = (seconds: number) => new Date(Date.now() + seconds * 1000);

export async function hashPassword(password: string) {
  const salt = randomBytes(16).toString('hex');
  const key = await scrypt(password, salt, 64) as Buffer;
  return `scrypt$${salt}$${key.toString('hex')}`;
}
export async function verifyPassword(password: string, encoded: string) {
  const [algorithm, salt, stored] = encoded.split('$');
  if (algorithm !== 'scrypt' || !salt || !stored) return false;
  const key = await scrypt(password, salt, 64) as Buffer;
  const expected = Buffer.from(stored, 'hex');
  return key.length === expected.length && timingSafeEqual(key, expected);
}
export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}
export function requireThat(condition: unknown, status: number, code: string, message: string): asserts condition {
  if (!condition) throw new ApiError(status, code, message);
}
