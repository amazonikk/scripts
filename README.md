# Notion AI Knowledge Base MVP

This project keeps the existing single-page interface and adds a small Node.js backend for the **Ask question** flow.

## What the MVP does

- Syncs a Notion root page or Notion database into a local JSON index.
- Builds a real dropdown of knowledge base sections from Notion.
- Searches only inside the selected section.
- Sends only the found context to Gemini Flash.
- Returns an answer plus source pages.
- Falls back with a clear no-answer message if the selected section has no exact information.

## Setup

1. Install dependencies:

```bash
npm install
```

2. Create `.env` from `.env.example` and fill in real values.

Example:

```env
NOTION_TOKEN=your_notion_integration_secret
NOTION_ROOT_PAGE_ID=your_root_page_id
# or
NOTION_DATABASE_ID=your_database_id

AI_PROVIDER=gemini
GEMINI_API_KEY=your_gemini_api_key
GEMINI_MODEL=gemini-2.5-flash
PORT=3000
```

## Environment variables

- `NOTION_TOKEN`
- `NOTION_ROOT_PAGE_ID` or `NOTION_DATABASE_ID`
- `AI_PROVIDER=gemini`
- `GEMINI_API_KEY`
- `GEMINI_MODEL=gemini-2.5-flash`
- `PORT`

Only Gemini is supported in this MVP. Keep the default Flash model unless you explicitly need another Gemini Flash variant.

## Getting the Notion token

1. Create a Notion integration in the Notion developer settings.
2. Copy the internal integration secret into `NOTION_TOKEN`.
3. Share the target root page or database with that integration.

Use either:

- `NOTION_ROOT_PAGE_ID` when the knowledge base starts from a page tree.
- `NOTION_DATABASE_ID` when the knowledge base starts from a database.

## How sync works

Use the `Sync Notion` button inside the **Ask question** section, or call:

```bash
POST /api/sync
```

On sync the backend:

- loads the Notion tree;
- collects root sections, nested pages, and subpages;
- extracts text blocks;
- splits text into chunks;
- stores sections, pages, chunks, source title, source path, Notion page id, and indexed time in `data/notion-index.json`.

This MVP uses local JSON indexing with keyword/full-text ranking, not vector embeddings.

## How to run

```bash
npm start
```

Then open:

```text
http://localhost:3000
```

## API

- `GET /api/health`
- `GET /api/sections`
- `POST /api/sync`
- `POST /api/ask`

### `POST /api/ask`

Request body:

```json
{
  "sectionId": "notion-section-id",
  "question": "What should we answer?",
  "language": "ua"
}
```

`language` is optional. If it is missing, the backend uses `ua` by default.

## How to ask a question

1. Open the page.
2. Choose a section in the dropdown.
3. Enter a question.
4. Click **Ask**.
5. Read the answer and sources below the form.

## Language behavior

The answer language follows the UI language:

- `UA` -> Ukrainian
- `RU` -> Russian
- `EN` -> English

If the selected section has no exact answer, the fallback message is shown in the same language.

## Testing

Without real keys you can still verify the app boots and the configuration/error states work:

- `node -c server.js`
- `npm start`
- `GET /api/health`
- confirm the page opens at `http://localhost:3000`
- confirm the Ask question block renders
- confirm missing config shows a clear error instead of a crash

With real keys you should additionally:

- run `POST /api/sync`
- choose a section from the dropdown
- ask a question
- confirm the answer is grounded only in the selected section
- confirm the no-answer fallback appears when the section has no exact information
- confirm sources are shown below the answer

## MVP limits

- No vector search yet.
- No Claude or OpenAI support in this MVP.
- No mocked answers.
- No fake Notion data.
- The quality of answers depends on the Notion structure and the text content inside synced pages.
