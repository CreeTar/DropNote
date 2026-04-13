# DropNote (Telegram Diary Bot)

DropNote ist ein serverless Telegram-Bot (Firebase Function), der strukturierte Tagebuchnotizen für Food-/Symptom-Tracking speichert.

## Features (v1)
- Text- und Voice-Nachrichten (Voice max. **15 Sekunden**)
- Deutsche Transkription für Voice (OpenAI `gpt-4o-mini-transcribe`, Sprache `de`)
- Zeitstempel-Erkennung aus Text (de/en), sonst Telegram-Nachrichtenzeit
- Speicherung in Firestore:
  - `eventAt` (Zeitpunkt der Beobachtung)
  - `note` (Notiztext)
  - `category` (optional, manuell)
- Kategorien-Auswahl via Inline-Buttons:
  - `Food`, `Symptom`, `Mood`, `Medication`, `Sleep`, `Exercise`, `Hydration`, `Note`
- Chat sauber halten:
  - Originalnachricht wird nach erfolgreicher Verarbeitung gelöscht (falls Telegram es erlaubt)
  - Eine Statusmeldung bleibt bestehen und wird aktualisiert (z. B. "12 Notizen, letzte vor 1 min.")

## Bot Commands
- `/help`
- `/show_last`
- `/delete_last`
- `/export_csv`
- `/export_last_7_days`

## Architektur
- **Telegram Webhook** -> Firebase HTTPS Function `telegramWebhook`
- **Firestore** als Datenbank
- Event-basierte Serverless Ausführung

## Setup
1. Abhängigkeiten installieren:
   ```bash
   npm install
   ```
2. Umgebungsvariablen setzen (z. B. in Cloud Functions Secret/Env):
   - `TELEGRAM_BOT_TOKEN`
   - `OPENAI_API_KEY` (für Voice-Transkription)
3. Firebase Projekt konfigurieren (`.firebaserc`).
4. Deploy:
   ```bash
   npm run deploy
   ```
5. Telegram Webhook auf die Function-URL setzen:
   ```bash
   curl -X POST "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook" \
     -d "url=https://<region>-<project>.cloudfunctions.net/telegramWebhook"
   ```

## Datenmodell (Firestore)
Collection: `entries`
- `chatId` (number)
- `userId` (number)
- `note` (string)
- `source` (`text` | `voice`)
- `eventAt` (timestamp)
- `category` (string | null)
- `createdAt` (timestamp)
- `updatedAt` (timestamp)
- `messageId` (number)

Collection: `chatMeta`
- `statusMessageId` (number)
- `updatedAt` (timestamp)

## Verbesserungen / Fragen für v2
- Mehrsprachigkeit optional per `/language` statt fix Deutsch.
- Bessere Zeit-Normalisierung (z. B. relative Zeiten in lokaler Zeitzone pro User).
- Duplikat-Schutz (idempotent über Telegram `update_id`).
- Optionaler Fallback für Voice ohne OpenAI (Google STT).
- Bessere Validierung bei unklarer Sprache/Noise mit Confidence Threshold.
- Optional Command `/set_category_default` für schnellere Eingabe.
- Soft-delete + Undo statt hartem Löschen bei `/delete_last`.
