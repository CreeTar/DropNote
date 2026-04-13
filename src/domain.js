const CATEGORY_PREFIXES = {
  Food: ['food:', 'essen:'],
  Symptom: ['symptom:'],
  Mood: ['mood:', 'stimmung:'],
  Medication: ['medication:', 'medikament:'],
  Sleep: ['sleep:', 'schlaf:'],
  Exercise: ['exercise:', 'sport:'],
  Hydration: ['hydration:', 'wasser:'],
  Note: ['note:']
};

export function detectManualCategory(text) {
  const lower = (text || '').trim().toLowerCase();
  for (const [category, prefixes] of Object.entries(CATEGORY_PREFIXES)) {
    if (prefixes.some((prefix) => lower.startsWith(prefix))) {
      return category;
    }
  }
  return null;
}

export function parseTextNote({ text, fallbackUnixSeconds, source = 'text', timeParser }) {
  const cleaned = text?.trim();
  if (!cleaned || cleaned.length < 2) {
    return { ok: false, error: 'Text zu kurz oder leer. Bitte erneut senden.' };
  }

  const parsedTime = typeof timeParser === 'function' ? timeParser(cleaned) : null;
  const eventAt = parsedTime ? new Date(parsedTime) : new Date(fallbackUnixSeconds * 1000);

  if (Number.isNaN(eventAt.getTime())) {
    return { ok: false, error: 'Zeitangabe konnte nicht gelesen werden. Bitte klarer formulieren.' };
  }

  return {
    ok: true,
    note: cleaned,
    source,
    category: detectManualCategory(cleaned),
    eventAt
  };
}

export function buildStatusText({ total, latestMillis, nowMillis = Date.now() }) {
  if (!total || total < 1) {
    return '0 Notizen gespeichert.';
  }

  if (!latestMillis) {
    return `${total} Notizen gespeichert.`;
  }

  const agoMin = Math.max(0, Math.floor((nowMillis - latestMillis) / 60000));
  return `${total} Notizen, letzte vor ${agoMin} min.`;
}

export function mapEntriesToCsvRows(entries, is7Days = false, nowMillis = Date.now()) {
  const cutoff = nowMillis - (7 * 24 * 60 * 60 * 1000);
  return entries
    .filter((e) => !is7Days || e.eventAtMillis >= cutoff)
    .map((e) => ({
      date_time: new Date(e.eventAtMillis).toISOString(),
      category: e.category || '',
      note: e.note,
      source: e.source
    }));
}
