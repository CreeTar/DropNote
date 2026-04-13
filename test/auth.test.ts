import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { createSessionToken, verifySessionToken, verifyTelegramLogin } from '../src/auth.js';

test('session token roundtrip', () => {
  const token = createSessionToken({ userId: '123', username: 'alice' }, 'secret');
  const parsed = verifySessionToken(token, 'secret');
  assert.equal(parsed?.userId, '123');
  assert.equal(parsed?.username, 'alice');
});

test('session token fails with wrong secret', () => {
  const token = createSessionToken({ userId: '123', username: 'alice' }, 'secret');
  const parsed = verifySessionToken(token, 'other');
  assert.equal(parsed, null);
});

test('telegram login verification works', () => {
  const botToken = '123:testtoken';
  const payload = {
    id: '42',
    username: 'bob',
    first_name: 'Bob',
    auth_date: String(Math.floor(Date.now() / 1000))
  };

  const checkString = Object.entries(payload)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');

  const secret = createHash('sha256').update(botToken).digest();
  const hash = createHmac('sha256', secret).update(checkString).digest('hex');

  const ok = verifyTelegramLogin({ ...payload, hash }, botToken);
  assert.equal(ok, true);
});
