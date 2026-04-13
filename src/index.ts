import { Buffer } from 'node:buffer';
import { Firestore } from '@google-cloud/firestore';
import { stringify } from 'csv-stringify/sync';
import * as chrono from 'chrono-node';
import { onRequest } from 'firebase-functions/v2/https';
import OpenAI from 'openai';
import { buildStatusText, mapEntriesToCsvRows, parseTextNote, type Category } from './domain.js';

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_API_BASE = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;
const TELEGRAM_FILE_API_BASE = `https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}`;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const db = new Firestore();
const openai = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;

const CATEGORIES: Category[] = ['Food', 'Symptom', 'Mood', 'Medication', 'Sleep', 'Exercise', 'Hydration', 'Note'];
const HELP_TEXT = `DropNote Bot – Befehle:\n\n` +
  `/help – Hilfe anzeigen\n` +
  `/show_last – Letzten Eintrag anzeigen\n` +
  `/delete_last – Letzten Eintrag löschen\n` +
  `/export_csv – Alle Einträge als CSV\n` +
  `/export_last_7_days – CSV der letzten 7 Tage`;

type TelegramMessage = {
  message_id: number;
  date: number;
  text?: string;
  voice?: { file_id: string; duration: number };
  from?: { id: number };
  chat?: { id: number };
};

type TelegramUpdate = { message?: TelegramMessage; callback_query?: TelegramCallbackQuery };

type TelegramCallbackQuery = {
  id: string;
  data?: string;
  message?: { message_id: number; chat?: { id: number } };
};

export const telegramWebhook = onRequest(async (req: any, res: any) => {
  if (!TELEGRAM_BOT_TOKEN) {
    res.status(500).send('TELEGRAM_BOT_TOKEN is missing');
    return;
  }

  try {
    const update = req.body as TelegramUpdate;

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

async function handleCommand(message: TelegramMessage): Promise<void> {
  const chatId = message.chat!.id;
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
    const snap = await db.collection('entries')
      .where('chatId', '==', chatId)
      .orderBy('eventAt', 'asc')
      .get();

    const rows = mapEntriesToCsvRows(
      snap.docs.map((d: any) => {
        const data = d.data() as { eventAt: { toMillis: () => number }; category?: string; note: string; source: string };
        return {
          eventAtMillis: data.eventAt.toMillis(),
          category: data.category,
          note: data.note,
          source: data.source
        };
      }),
      is7Days
    );

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

async function parseIncomingMessage(message: TelegramMessage) {
  if (message.text) {
    return parseTextMessage(message.text, message.date);
  }

  if (message.voice) {
    if (message.voice.duration > 15) {
      return { ok: false as const, error: 'Sprachnachricht ist zu lang (max. 15 Sekunden).' };
    }

    const transcript = await transcribeVoice(message.voice.file_id);
    if (!transcript || transcript.trim().length < 2) {
      return { ok: false as const, error: 'Sprachnachricht unklar oder zu kurz. Bitte wiederholen.' };
    }

    return parseTextMessage(transcript, message.date, 'voice');
  }

  return { ok: false as const, error: 'Bitte sende Text oder eine Sprachnachricht.' };
}

function parseTextMessage(text: string, fallbackUnixSeconds: number, source: 'text' | 'voice' = 'text') {
  return parseTextNote({
    text,
    fallbackUnixSeconds,
    source,
    timeParser: (input) => chrono.de.parseDate(input) || chrono.en.parseDate(input)
  });
}

async function transcribeVoice(fileId: string): Promise<string | null> {
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

async function getTelegramFilePath(fileId: string): Promise<string> {
  const payload = await telegramApi('getFile', { file_id: fileId });
  return payload.result.file_path;
}

async function saveEntry(entry: {
  chatId: number;
  userId?: number;
  note: string;
  source: string;
  eventAt: Date;
  category: string | null;
  messageId: number;
}) {
  return db.collection('entries').add({
    ...entry,
    eventAt: new Date(entry.eventAt),
    createdAt: new Date(),
    updatedAt: new Date()
  });
}

async function askForCategory(chatId: number, entryId: string): Promise<void> {
  const inline_keyboard: Array<Array<{ text: string; callback_data: string }>> = [];
  for (let i = 0; i < CATEGORIES.length; i += 2) {
    inline_keyboard.push(
      CATEGORIES.slice(i, i + 2).map((category) => ({ text: category, callback_data: `cat:${entryId}:${category}` }))
    );
  }

  await sendMessage(chatId, 'Bitte Kategorie wählen:', { inline_keyboard });
}

async function handleCallback(callbackQuery: TelegramCallbackQuery): Promise<void> {
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

function formatEntry(doc: { eventAt: { toDate: () => Date }; category?: string; note: string }): string {
  const dt = doc.eventAt.toDate().toISOString();
  return `📝 ${dt}\nKategorie: ${doc.category || '—'}\nNotiz: ${doc.note}`;
}

async function upsertStatusMessage(chatId: number): Promise<void> {
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
  const latest = !snap.empty ? (snap.docs[0].data() as { eventAt?: { toMillis?: () => number } }) : null;
  const status = buildStatusText({
    total,
    latestMillis: latest?.eventAt?.toMillis?.()
  });

  const metaRef = db.collection('chatMeta').doc(String(chatId));
  const meta = await metaRef.get();
  const statusMessageId = meta.exists ? (meta.data() as { statusMessageId?: number }).statusMessageId : null;

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

async function tryDeleteOriginalMessage(chatId: number, messageId: number): Promise<void> {
  try {
    await telegramApi('deleteMessage', { chat_id: chatId, message_id: messageId });
  } catch {
    // Telegram may deny deletion in some contexts.
  }
}

async function sendMessage(chatId: number, text: string, reply_markup?: unknown) {
  return telegramApi('sendMessage', {
    chat_id: chatId,
    text,
    reply_markup
  });
}

async function editMessage(chatId: number, messageId: number, text: string) {
  return telegramApi('editMessageText', {
    chat_id: chatId,
    message_id: messageId,
    text
  });
}

async function answerCallbackQuery(callbackQueryId: string, text: string) {
  return telegramApi('answerCallbackQuery', {
    callback_query_id: callbackQueryId,
    text,
    show_alert: false
  });
}

async function sendDocument(chatId: number, filename: string, content: string): Promise<unknown> {
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

async function telegramApi(method: string, payload: unknown): Promise<any> {
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
