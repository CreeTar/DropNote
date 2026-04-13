import test from 'node:test';
import assert from 'node:assert/strict';
import { buildStatusText, detectManualCategory, mapEntriesToCsvRows, parseTextNote } from '../src/domain.js';

test('detectManualCategory supports german and english prefixes', () => {
  assert.equal(detectManualCategory('essen: milch und brot'), 'Food');
  assert.equal(detectManualCategory('symptom: bauchkrampf'), 'Symptom');
  assert.equal(detectManualCategory('stimmung: gut'), 'Mood');
  assert.equal(detectManualCategory('random text'), null);
});

test('parseTextNote uses fallback timestamp when parser finds no explicit time', () => {
  const result = parseTextNote({
    text: 'essen: milch',
    fallbackUnixSeconds: 1710000000,
    source: 'text',
    timeParser: () => null
  });

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.category, 'Food');
    assert.equal(result.eventAt.toISOString(), '2024-03-09T16:00:00.000Z');
  }
});

test('parseTextNote surfaces validation errors', () => {
  const short = parseTextNote({ text: ' ', fallbackUnixSeconds: 1710000000 });
  assert.equal(short.ok, false);
});

test('buildStatusText handles empty and non-empty states', () => {
  assert.equal(buildStatusText({ total: 0 }), '0 Notizen gespeichert.');
  assert.equal(
    buildStatusText({ total: 12, latestMillis: 1_000, nowMillis: 121_000 }),
    '12 Notizen, letzte vor 2 min.'
  );
});

test('mapEntriesToCsvRows filters by last 7 days when enabled', () => {
  const now = Date.parse('2026-04-13T00:00:00.000Z');
  const rows = mapEntriesToCsvRows([
    { eventAtMillis: now - (2 * 24 * 60 * 60 * 1000), category: 'Food', note: 'milch', source: 'text' },
    { eventAtMillis: now - (10 * 24 * 60 * 60 * 1000), category: 'Symptom', note: 'krampf', source: 'voice' }
  ], true, now);

  assert.equal(rows.length, 1);
  assert.equal(rows[0].category, 'Food');
});
