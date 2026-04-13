import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { Buffer } from 'node:buffer';

export type TelegramAuthPayload = {
  id: string;
  first_name?: string;
  last_name?: string;
  username?: string;
  photo_url?: string;
  auth_date: string;
  hash: string;
};

export function verifyTelegramLogin(payload: TelegramAuthPayload, botToken: string, maxAgeSeconds = 86400): boolean {
  if (!botToken || !payload?.hash || !payload?.id || !payload?.auth_date) return false;

  const authDate = Number(payload.auth_date);
  if (!Number.isFinite(authDate)) return false;

  const nowSeconds = Math.floor(Date.now() / 1000);
  if (nowSeconds - authDate > maxAgeSeconds) return false;

  const checkString = Object.entries(payload)
    .filter(([key, value]) => key !== 'hash' && value !== undefined && value !== null && value !== '')
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');

  const secret = createHash('sha256').update(botToken).digest();
  const computed = createHmac('sha256', secret).update(checkString).digest('hex');

  const givenBuffer = Buffer.from(payload.hash, 'hex');
  const computedBuffer = Buffer.from(computed, 'hex');

  if (givenBuffer.length !== computedBuffer.length) return false;
  return timingSafeEqual(givenBuffer, computedBuffer);
}

export function createSessionToken(data: { userId: string; username?: string }, sessionSecret: string): string {
  const payload = {
    userId: data.userId,
    username: data.username || '',
    iat: Math.floor(Date.now() / 1000)
  };

  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = createHmac('sha256', sessionSecret).update(encoded).digest('base64url');
  return `${encoded}.${sig}`;
}

export function verifySessionToken(token: string, sessionSecret: string): { userId: string; username: string } | null {
  if (!token?.includes('.')) return null;
  const [encoded, sig] = token.split('.');
  const expected = createHmac('sha256', sessionSecret).update(encoded).digest('base64url');

  const sigBuffer = Buffer.from(sig);
  const expectedBuffer = Buffer.from(expected);
  if (sigBuffer.length !== expectedBuffer.length) return null;
  if (!timingSafeEqual(sigBuffer, expectedBuffer)) return null;

  const parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as {
    userId: string;
    username: string;
    iat: number;
  };

  if (!parsed?.userId) return null;
  return { userId: parsed.userId, username: parsed.username || '' };
}
