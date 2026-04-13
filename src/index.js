import { Buffer } from 'node:buffer';
import { Firestore } from '@google-cloud/firestore';
import { stringify } from 'csv-stringify/sync';
import * as chrono from 'chrono-node';
import { onRequest } from 'firebase-functions/v2/https';
import OpenAI from 'openai';

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_API_BASE = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;
const TELEGRAM_FILE_API_BASE = `https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}`;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const db = new Firestore();
const openai = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;

const CATEGORIES = ['Food', 'Symptom', 'Mood', 'Medication', 'Sleep', 'Exercise', 'Hydration', 'Note'];
const HELP_TEXT = `DropNote Bot – Befehle:\n\n` +
  `/help – Hilfe anzeigen\n` +
  `/show_last – Letzten Eintrag anzeigen\n` +
  `/delete_last – Letzten Eintrag löschen\n` +
  `/export_csv – Alle Einträge als CSV\n` +
  `/export_last_7_days – CSV der letzten 7 Tage`;

export const telegramWebhook = onRequest(async (req, res) => {
  if (!TELEGRAM_BOT_TOKEN) {
    res.status(500).send('TELEGRAM_BOT_TOKEN is missing');
    return;
  }

  try {
    const update = req.body;

    if (update.callback_query) {
      await handleCallback(update.callback_query);
      res.status(200).send('ok');
      return;
    }

    if (!update.message) {
      res.status(200).send('ignored');
      return;
    }

    const message = update.message;
    const chatId = message.chat?.id;

    if (!chatId) {
      res.status(200).send('ignored');
      return;
    }

    if (message.text?.startsWith('/')) {
      await handleCommand(message);
      res.status(200).send('ok');
      return;
    }

    const parsed = await parseIncomingMessage(message);
    if (!parsed.ok) {
      await sendMessage(chatId, `⚠️ ${parsed.error}`);
      res.status(200).send('ok');
      return;
    }

    const entryRef = await saveEntry({
      chatId,
      userId: message.from?.id,
      note: parsed.note,
      source: parsed.source,
      eventAt: parsed.eventAt,
      category: parsed.category || null,
      messageId: message.message_id
    });

    await tryDeleteOriginalMessage(chatId, message.message_id);

    if (!parsed.category) {
      await askForCategory(chatId, entryRef.id);
    }

    await upsertStatusMessage(chatId);

    res.status(200).send('ok');
  } catch (error) {
    console.error(error);
    res.status(500).send('error');
  }
});

async function handleCommand(message) {
  const chatId = message.chat.id;
  const command = (message.text || '').split(' ')[0].trim();

  if (command === '/help') {
    await sendMessage(chatId, HELP_TEXT);
    return;
  }

  if (command === '/show_last') {
    const snap = await db.collection('entries')
      .where('chatId', '==', chatId)
      .orderBy('eventAt', 'desc')
      .limit(1)
      .get();

    if (snap.empty) {
      await sendMessage(chatId, 'Keine Einträge gefunden.');
      return;
    }

    const doc = snap.docs[0].data();
    await sendMessage(chatId, formatEntry(doc));
    return;
  }

  if (command === '/delete_last') {
    const snap = await db.collection('entries')
      .where('chatId', '==', chatId)
      .orderBy('eventAt', 'desc')
      .limit(1)
      .get();

    if (snap.empty) {
      await sendMessage(chatId, 'Nichts zu löschen.');
      return;
    }

    await snap.docs[0].ref.delete();
    await sendMessage(chatId, 'Letzter Eintrag gelöscht.');
    await upsertStatusMessage(chatId);
    return;
  }

  if (command === '/export_csv' || command === '/export_last_7_days') {
    const is7Days = command === '/export_last_7_days';
    const q = db.collection('entries')
      .where('chatId', '==', chatId)
      .orderBy('eventAt', 'asc');

    const snap = await q.get();
    const cutoff = Date.now() - (7 * 24 * 60 * 60 * 1000);
    const rows = snap.docs
      .map((d) => ({ id: d.id, ...d.data() }))
      .filter((d) => !is7Days || d.eventAt.toMillis() >= cutoff)
      .map((d) => ({
        date_time: d.eventAt.toDate().toISOString(),
        category: d.category || '',
        note: d.note,
        source: d.source
      }));

    if (rows.length === 0) {
      await sendMessage(chatId, 'Keine Einträge für den Export gefunden.');
      return;
    }

    const csv = stringify(rows, { header: true });
    const filename = is7Days ? 'dropnote_last_7_days.csv' : 'dropnote_all.csv';
    await sendDocument(chatId, filename, csv);
    return;
  }

  await sendMessage(chatId, 'Unbekannter Befehl. Nutze /help.');
}

async function parseIncomingMessage(message) {
  if (message.text) {
    return parseTextMessage(message.text, message.date);
  }

  if (message.voice) {
    if (message.voice.duration > 15) {
      return { ok: false, error: 'Sprachnachricht ist zu lang (max. 15 Sekunden).' };
    }

    const transcript = await transcribeVoice(message.voice.file_id);
    if (!transcript || transcript.trim().length < 2) {
      return { ok: false, error: 'Sprachnachricht unklar oder zu kurz. Bitte wiederholen.' };
    }

    return parseTextMessage(transcript, message.date, 'voice');
  }

  return { ok: false, error: 'Bitte sende Text oder eine Sprachnachricht.' };
}

function parseTextMessage(text, fallbackUnixSeconds, source = 'text') {
  const cleaned = text?.trim();
  if (!cleaned || cleaned.length < 2) {
    return { ok: false, error: 'Text zu kurz oder leer. Bitte erneut senden.' };
  }

  const parsedTime = chrono.de.parseDate(cleaned) || chrono.en.parseDate(cleaned);
  const eventAt = parsedTime ? new Date(parsedTime) : new Date(fallbackUnixSeconds * 1000);

  if (Number.isNaN(eventAt.getTime())) {
    return { ok: false, error: 'Zeitangabe konnte nicht gelesen werden. Bitte klarer formulieren.' };
  }

  const category = detectManualCategory(cleaned);

  return {
    ok: true,
    note: cleaned,
    source,
    category,
    eventAt
  };
}

function detectManualCategory(text) {
  const lower = text.toLowerCase();
  if (lower.startsWith('food:') || lower.startsWith('essen:')) return 'Food';
  if (lower.startsWith('symptom:')) return 'Symptom';
  if (lower.startsWith('mood:') || lower.startsWith('stimmung:')) return 'Mood';
  if (lower.startsWith('medication:') || lower.startsWith('medikament:')) return 'Medication';
  if (lower.startsWith('sleep:') || lower.startsWith('schlaf:')) return 'Sleep';
  if (lower.startsWith('exercise:') || lower.startsWith('sport:')) return 'Exercise';
  if (lower.startsWith('hydration:') || lower.startsWith('wasser:')) return 'Hydration';
  if (lower.startsWith('note:')) return 'Note';
  return null;
}

async function transcribeVoice(fileId) {
  if (!openai) {
    return null;
  }

  const filePath = await getTelegramFilePath(fileId);
  const audioUrl = `${TELEGRAM_FILE_API_BASE}/${filePath}`;
  const audioResponse = await fetch(audioUrl);
  if (!audioResponse.ok) {
    throw new Error('Failed to download voice message');
  }

  const arrayBuffer = await audioResponse.arrayBuffer();
  const file = new File([Buffer.from(arrayBuffer)], 'voice.ogg', { type: 'audio/ogg' });

  const transcription = await openai.audio.transcriptions.create({
    file,
    model: 'gpt-4o-mini-transcribe',
    language: 'de'
  });

  return transcription.text;
}

async function getTelegramFilePath(fileId) {
  const payload = await telegramApi('getFile', { file_id: fileId });
  return payload.result.file_path;
}

async function saveEntry(entry) {
  return db.collection('entries').add({
    ...entry,
    eventAt: new Date(entry.eventAt),
    createdAt: new Date(),
    updatedAt: new Date()
  });
}

async function askForCategory(chatId, entryId) {
  const inline_keyboard = [];
  for (let i = 0; i < CATEGORIES.length; i += 2) {
    inline_keyboard.push(
      CATEGORIES.slice(i, i + 2).map((category) => ({ text: category, callback_data: `cat:${entryId}:${category}` }))
    );
  }

  await sendMessage(chatId, 'Bitte Kategorie wählen:', { inline_keyboard });
}

async function handleCallback(callbackQuery) {
  const chatId = callbackQuery.message?.chat?.id;
  const messageId = callbackQuery.message?.message_id;
  if (!chatId || !callbackQuery.data) return;

  if (callbackQuery.data.startsWith('cat:')) {
    const [, entryId, category] = callbackQuery.data.split(':');
    const ref = db.collection('entries').doc(entryId);
    const snap = await ref.get();

    if (!snap.exists) {
      await answerCallbackQuery(callbackQuery.id, 'Eintrag nicht gefunden.');
      return;
    }

    await ref.update({ category, updatedAt: new Date() });
    await answerCallbackQuery(callbackQuery.id, `Kategorie gespeichert: ${category}`);

    if (messageId) {
      await editMessage(chatId, messageId, `✅ Kategorie gesetzt: ${category}`);
    }

    await upsertStatusMessage(chatId);
  }
}

function formatEntry(doc) {
  const dt = doc.eventAt.toDate().toISOString();
  return `📝 ${dt}\nKategorie: ${doc.category || '—'}\nNotiz: ${doc.note}`;
}

async function upsertStatusMessage(chatId) {
  const snap = await db.collection('entries')
    .where('chatId', '==', chatId)
    .orderBy('eventAt', 'desc')
    .limit(1)
    .get();

  const totalSnap = await db.collection('entries')
    .where('chatId', '==', chatId)
    .count()
    .get();

  const total = totalSnap.data().count;
  let status = `${total} Notizen gespeichert.`;

  if (!snap.empty) {
    const latest = snap.docs[0].data();
    const agoMin = Math.max(0, Math.floor((Date.now() - latest.eventAt.toMillis()) / 60000));
    status = `${total} Notizen, letzte vor ${agoMin} min.`;
  }

  const metaRef = db.collection('chatMeta').doc(String(chatId));
  const meta = await metaRef.get();
  const statusMessageId = meta.exists ? meta.data().statusMessageId : null;

  if (statusMessageId) {
    const edited = await editMessage(chatId, statusMessageId, status);
    if (edited.ok) return;
  }

  const sent = await sendMessage(chatId, status);
  await metaRef.set({
    statusMessageId: sent.result.message_id,
    updatedAt: new Date()
  }, { merge: true });
}

async function tryDeleteOriginalMessage(chatId, messageId) {
  try {
    await telegramApi('deleteMessage', { chat_id: chatId, message_id: messageId });
  } catch {
    // Telegram may deny deletion in some contexts.
  }
}

async function sendMessage(chatId, text, reply_markup) {
  return telegramApi('sendMessage', {
    chat_id: chatId,
    text,
    reply_markup
  });
}

async function editMessage(chatId, messageId, text) {
  return telegramApi('editMessageText', {
    chat_id: chatId,
    message_id: messageId,
    text
  });
}

async function answerCallbackQuery(callbackQueryId, text) {
  return telegramApi('answerCallbackQuery', {
    callback_query_id: callbackQueryId,
    text,
    show_alert: false
  });
}

async function sendDocument(chatId, filename, content) {
  const formData = new FormData();
  formData.append('chat_id', String(chatId));
  formData.append('document', new Blob([content], { type: 'text/csv' }), filename);

  const response = await fetch(`${TELEGRAM_API_BASE}/sendDocument`, {
    method: 'POST',
    body: formData
  });

  if (!response.ok) {
    throw new Error(`sendDocument failed: ${response.status}`);
  }

  return response.json();
}

async function telegramApi(method, payload) {
  const response = await fetch(`${TELEGRAM_API_BASE}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  const data = await response.json();
  if (!response.ok || !data.ok) {
    throw new Error(`Telegram API ${method} failed: ${JSON.stringify(data)}`);
  }

  return data;
}
