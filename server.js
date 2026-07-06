const fs = require('fs/promises');
const path = require('path');
const express = require('express');
const dotenv = require('dotenv');
const { Client: NotionClient } = require('@notionhq/client');
const { GoogleGenerativeAI } = require('@google/generative-ai');

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT || 3000);
const AI_PROVIDER = String(process.env.AI_PROVIDER || 'gemini').toLowerCase();
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const BOOTED_AT = new Date().toISOString();
const DEFAULT_LANGUAGE = 'ua';
const FALLBACK_ANSWERS = {
  ua: 'У вибраному розділі бази знань немає інформації для точної відповіді.',
  ru: 'В выбранном разделе базы знаний нет информации для точного ответа.',
  en: 'There is no information in the selected knowledge base section for an accurate answer.'
};

const ROOT_DIR = __dirname;
const DATA_DIR = path.join(ROOT_DIR, 'data');
const INDEX_PATH = path.join(DATA_DIR, 'notion-index.json');

const notionToken = process.env.NOTION_TOKEN || '';
const notionRootPageId = process.env.NOTION_ROOT_PAGE_ID || '';
const notionDatabaseId = process.env.NOTION_DATABASE_ID || '';
const notionSourceId = notionRootPageId || notionDatabaseId || '';
const notionSourceType = notionRootPageId ? 'page' : (notionDatabaseId ? 'database' : '');

const notion = notionToken ? new NotionClient({ auth: notionToken }) : null;
let indexCache = null;

app.use(express.json({ limit: '2mb' }));

app.get('/', async (_req, res) => {
  res.sendFile(path.join(ROOT_DIR, 'index.html'));
});

app.get('/api/health', async (_req, res) => {
  const index = await loadIndex();
  res.json({
    ok: true,
    configured: Boolean(notion && notionSourceId && AI_PROVIDER === 'gemini' && process.env.GEMINI_API_KEY),
    pid: process.pid,
    bootedAt: BOOTED_AT,
    aiProvider: AI_PROVIDER,
    geminiModel: GEMINI_MODEL,
    sourceType: notionSourceType || null,
    missingEnvKeys: getMissingEnvKeys(),
    sections: index.sections.length,
    chunks: index.chunks.length,
    indexedAt: index.indexedAt || null
  });
});

app.get('/api/sections', async (_req, res) => {
  try {
    let index = await loadIndex();
    if (!index.sections.length && canSync()) {
      index = await syncNotion();
    }
    if (!index.sections.length) {
      return res.status(400).json({
        error: canSync()
          ? 'No sections were found in Notion. Run Sync Notion after confirming the root page or database has content.'
          : 'Notion is not configured. Set NOTION_TOKEN and either NOTION_ROOT_PAGE_ID or NOTION_DATABASE_ID.'
      });
    }
    const query = String(_req.query?.q || _req.query?.search || '').trim();
    const limit = clampInteger(_req.query?.limit, 5, 1, 20);
    const sections = query
      ? searchSections(index.sections, query, limit)
      : index.sections;
    res.json({
      query: query || null,
      sections: sections.map(section => ({
        id: section.id,
        title: section.title,
        path: section.path,
        sectionType: section.sectionType,
        depth: section.depth,
        sourceTitle: section.sourceTitle || null,
        sourcePath: section.sourcePath || null
      }))
    });
  } catch (error) {
    res.status(400).json({ error: error.message || 'Failed to load sections.' });
  }
});

app.post('/api/sync', async (_req, res) => {
  try {
    const index = await syncNotion();
    res.json({
      ok: true,
      message: `Synced ${index.sections.length} sections and ${index.chunks.length} content chunks.`,
      sections: index.sections.length,
      chunks: index.chunks.length,
      indexedAt: index.indexedAt
    });
  } catch (error) {
    const details = formatErrorDetails(error);
    console.error('[api/sync]', `${details.name}: ${details.message}`);
    res.status(error.status || error.statusCode || 400).json({
      error: details.message || 'Sync failed.',
      details
    });
  }
});

app.post('/api/ask', async (req, res) => {
  try {
    const question = String(req.body?.question || '').trim();
    const sectionId = String(req.body?.sectionId || '').trim();
    const language = normalizeLanguage(req.body?.language || req.body?.uiLang);
    const debug = Boolean(req.body?.debug);
    if (!question) {
      return res.status(400).json({ error: 'Question is required.' });
    }
    const questionMode = buildQuestionMode(question);

    let index = await loadIndex();
    if (!index.sections.length && canSync()) {
      index = await syncNotion();
    }

    let section = null;
    if (sectionId) {
      section = index.sections.find(item => item.id === sectionId);
      if (!section) {
        return res.status(404).json({ error: 'Selected section was not found. Sync Notion first.' });
      }
    }

    const answerPayload = await answerFromIndex({ index, question, section, language, debug, mode: questionMode });
    res.json(answerPayload);
  } catch (error) {
    const details = formatErrorDetails(error);
    console.error('[api/ask]', `${details.name}: ${details.message}`);
    res.status(error.status || error.statusCode || 400).json({
      error: details.message || 'Answer generation failed.',
      details
    });
  }
});

app.use((error, _req, res, _next) => {
  res.status(500).json({ error: error.message || 'Unexpected server error.' });
});

async function main() {
  if (process.argv.includes('--sync')) {
    await syncNotion();
    return;
  }

  await ensureDataDir();
  await loadIndex();
  if (canSync()) {
    syncNotion().catch(error => {
      const details = formatErrorDetails(error);
      console.error('[notion-sync]', `${details.name}: ${details.message}`);
    });
  }

  app.listen(PORT, () => {
    console.log(`Server listening on http://localhost:${PORT} (pid=${process.pid}, model=${GEMINI_MODEL})`);
  });
}

function canSync() {
  return Boolean(notion && notionSourceId && notionSourceType);
}

function hasGemini() {
  return AI_PROVIDER === 'gemini' && Boolean(process.env.GEMINI_API_KEY);
}

function clampInteger(value, fallback, min, max) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

function searchSections(sections, query, limit = 5) {
  return scoreSections(sections, query)
    .filter(section => section.score > 0)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (a.path === b.path) return a.id.localeCompare(b.id, 'uk');
      return a.path.localeCompare(b.path, 'uk');
    })
    .slice(0, limit)
    .map(({ score, ...section }) => section);
}

function scoreSections(sections, query, mode = 'fact') {
  const normalizedQuery = normalize(query);
  if (!normalizedQuery) {
    return sections.map(section => ({ ...section, score: 0 }));
  }

  const queryTokens = tokenize(query);
  const intents = mode === 'client_reply' ? detectRetrievalIntents(query, null, mode) : [];
  const intentTerms = mode === 'client_reply' ? getIntentTerms() : {};
  return sections.map(section => {
    const title = normalize(section.title);
    const path = normalize(section.path);
    const sectionTokens = tokenize(`${section.title || ''} ${section.path || ''}`);
    let score = 0;

    if (title === normalizedQuery) score += 120;
    if (path === normalizedQuery) score += 100;
    if (title.startsWith(normalizedQuery)) score += 60;
    if (path.startsWith(normalizedQuery)) score += 50;
    if (title.includes(normalizedQuery)) score += 40;
    if (path.includes(normalizedQuery)) score += 30;

    for (const token of queryTokens) {
      if (!token) continue;
      if (title.includes(token)) score += Math.min(16, token.length * 2);
      if (path.includes(token)) score += Math.min(12, token.length * 2);
      if (sectionTokens.some(value => value === token)) score += 12;
      if (sectionTokens.some(value => value.startsWith(token) || token.startsWith(value))) score += 6;
    }

    if (queryTokens.length && queryTokens.every(token => title.includes(token) || path.includes(token))) {
      score += 24;
    }

    for (const intent of intents) {
      const terms = intentTerms[intent] || [];
      if (terms.some(term => title.includes(normalize(term)) || path.includes(normalize(term)))) {
        score += mode === 'client_reply' ? 32 : 18;
      }
    }

    if (mode === 'client_reply') {
      const replyTerms = (getIntentTerms().client_reply || []).map(term => normalize(term));
      const hasReplyMarker = replyTerms.some(term => term && (title.includes(term) || path.includes(term)));
      if (hasReplyMarker) {
        score += 24;
      } else {
        score -= 12;
      }
    }

    if (isBroadRootSection(section)) {
      const exactRootMatch = normalizedQuery && (title === normalizedQuery || path === normalizedQuery);
      if (!exactRootMatch) {
        score -= 40;
      }
    } else if (section.depth === 0 && String(section.title || '').trim().length <= 24) {
      score -= 8;
    }

    return { ...section, score };
  });
}

function selectRelevantSections(index, question, limit = 5, mode = 'fact') {
  const sectionScores = new Map();
  const sectionChunkCounts = new Map();

  for (const section of scoreSections(index.sections, question, mode)) {
    if (section.score > 0) {
      sectionScores.set(section.id, section);
    }
  }

  const chunkScores = rankChunks(question, index.chunks, mode).slice(0, 80);
  for (const chunk of chunkScores) {
    const section = index.sections.find(item => item.id === chunk.pageId) || index.sections.find(item => item.id === chunk.sectionId);
    if (!section) continue;
    const current = sectionScores.get(section.id);
    if (!current && chunk.score < 8) continue;
    const next = current || { ...section, score: 0 };
    next.score += Math.max(chunk.score, 1);
    sectionScores.set(section.id, next);
    sectionChunkCounts.set(section.id, (sectionChunkCounts.get(section.id) || 0) + 1);
  }

  const ranked = Array.from(sectionScores.values())
    .map(section => {
      const pathDepth = Math.max(1, String(section.path || '').split(' / ').length);
      const chunkCount = sectionChunkCounts.get(section.id) || 0;
      const specificityBonus = Math.min(14, (Number(section.depth || 0) * 1.5) + (pathDepth - 1) * 1.25);
      const breadthPenalty = Math.min(22, Math.max(0, chunkCount - 8) * 0.75);
      return {
        ...section,
        score: section.score + specificityBonus - breadthPenalty
      };
    })
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (a.path === b.path) return a.id.localeCompare(b.id, 'uk');
      return a.path.localeCompare(b.path, 'uk');
    });

  const specificSections = ranked.filter(section => !isBroadRootSection(section));
  if (specificSections.length) {
    return specificSections.slice(0, limit).map(({ score, ...section }) => section);
  }

  if (ranked.length) {
    return ranked.slice(0, limit).map(({ score, ...section }) => section);
  }

  return index.sections.slice(0, limit);
}

function isBroadRootSection(section) {
  return Boolean(section && section.sectionType === 'database' && Number(section.depth || 0) === 0);
}

function collectChunksForSections(index, sections) {
  const selectedSections = Array.isArray(sections) ? sections.filter(Boolean) : [];
  if (!selectedSections.length) return [];

  const selectedSectionIds = new Set(selectedSections.map(section => section.id));
  const selectedPaths = selectedSections
    .map(section => String(section.path || section.title || '').trim())
    .filter(Boolean);
  const seen = new Set();
  const chunks = [];

  for (const chunk of index.chunks) {
    const chunkPath = String(chunk.path || '').trim();
    const matchesSection = selectedSectionIds.has(chunk.sectionId);
    const matchesPath = selectedPaths.some(path => chunkPath === path || chunkPath.startsWith(`${path} /`));
    if (!matchesSection && !matchesPath) continue;

    const key = `${chunk.pageId}|${chunk.path}|${chunk.text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    chunks.push(chunk);
  }

  return chunks;
}

async function ensureDataDir() {
  await fs.mkdir(DATA_DIR, { recursive: true });
}

async function loadIndex() {
  if (indexCache) return indexCache;
  try {
    const raw = await fs.readFile(INDEX_PATH, 'utf8');
    indexCache = JSON.parse(raw);
  } catch (_error) {
    indexCache = {
      indexedAt: null,
      source: null,
      sections: [],
      pages: [],
      chunks: []
    };
  }
  return indexCache;
}

async function saveIndex(index) {
  await ensureDataDir();
  indexCache = index;
  await fs.writeFile(INDEX_PATH, `${JSON.stringify(index, null, 2)}\n`, 'utf8');
  return indexCache;
}

async function syncNotion() {
  if (!canSync()) {
    throw new Error('Notion is not configured. Set NOTION_TOKEN and either NOTION_ROOT_PAGE_ID or NOTION_DATABASE_ID.');
  }

  await ensureDataDir();
  const sourceInfo = await getSourceInfo();
  const debug = createSyncDebug(sourceInfo);

  const index = {
    indexedAt: new Date().toISOString(),
    source: {
      type: notionSourceType,
      id: notionSourceId,
      title: sourceInfo.title,
      path: sourceInfo.path,
      notionPageId: notionSourceType === 'page' ? notionSourceId : null,
      notionDatabaseId: notionSourceType === 'database' ? notionSourceId : null
    },
    sections: [],
    pages: [],
    chunks: []
  };

  const pageMap = new Map();
  const sectionMap = new Map();
  const visitedContainers = new Set();

  if (notionSourceType === 'page') {
    const rootPage = await notion.pages.retrieve({ page_id: notionRootPageId });
    const rootTitle = sourceInfo.title || getPageTitle(rootPage) || 'Notion root';
    const children = await listBlocks(notionRootPageId);
    const topLevelPages = children.filter(block => block.type === 'child_page');

    if (topLevelPages.length) {
      for (const block of topLevelPages) {
        const title = block.child_page?.title || 'Untitled section';
        const section = {
          id: block.id,
          title,
          path: title,
          sectionType: 'page',
          depth: 0,
          sourceTitle: rootTitle,
          sourcePath: rootTitle
        };
        index.sections.push(section);
        sectionMap.set(section.id, section);
        await crawlContainer(block.id, {
          sectionId: section.id,
          sectionTitle: section.title,
          pageId: block.id,
          pageTitle: title,
          path: [title],
          depth: 0,
          sourceTitle: rootTitle,
          sourcePath: rootTitle
        }, index, sectionMap, pageMap, visitedContainers, debug);
      }
    } else {
      const section = {
        id: notionRootPageId,
        title: rootTitle,
        path: rootTitle,
        sectionType: 'page',
        depth: 0,
        sourceTitle: rootTitle,
        sourcePath: rootTitle
      };
      index.sections.push(section);
      sectionMap.set(section.id, section);
      await crawlContainer(notionRootPageId, {
        sectionId: section.id,
        sectionTitle: section.title,
        pageId: notionRootPageId,
        pageTitle: rootTitle,
        path: [rootTitle],
        depth: 0,
        sourceTitle: rootTitle,
        sourcePath: rootTitle
      }, index, sectionMap, pageMap, visitedContainers, debug);
    }
  } else if (notionSourceType === 'database') {
    const pages = await listDatabasePages(notionDatabaseId, debug);
    const rootTitle = sourceInfo.title || 'Notion database';
    for (const page of pages) {
      const title = getPageTitle(page) || 'Untitled section';
      const section = {
        id: page.id,
        title,
        path: title,
        sectionType: 'database',
        depth: 0,
        sourceTitle: rootTitle,
        sourcePath: rootTitle
      };
      index.sections.push(section);
      sectionMap.set(section.id, section);
      await crawlContainer(page.id, {
        sectionId: section.id,
        sectionTitle: section.title,
        pageId: page.id,
        pageTitle: title,
        path: [title],
        depth: 0,
        sourceTitle: rootTitle,
        sourcePath: rootTitle
      }, index, sectionMap, pageMap, visitedContainers, debug);
    }
  }

  const sectionRecords = new Map();
  for (const section of index.sections) {
    sectionRecords.set(section.id, section);
  }
  for (const section of sectionMap.values()) {
    if (!sectionRecords.has(section.id)) {
      sectionRecords.set(section.id, section);
    }
  }
  index.sections = Array.from(sectionRecords.values()).sort((a, b) => {
    if (a.path === b.path) return a.id.localeCompare(b.id, 'uk');
    return a.path.localeCompare(b.path, 'uk');
  });
  index.pages = Array.from(pageMap.values()).sort((a, b) => {
    if (a.sectionId === b.sectionId) return a.path.localeCompare(b.path, 'uk');
    return a.sectionId.localeCompare(b.sectionId, 'uk');
  });
  index.chunks.sort((a, b) => {
    if (a.sectionId === b.sectionId) return a.order - b.order;
    return a.sectionId.localeCompare(b.sectionId, 'uk');
  });

  return saveIndex(index);
}

async function listDatabasePages(databaseId, debug = null, label = '') {
  const pages = [];
  let cursor;
  do {
    const response = await withTimeout(
      notion.databases.query({
        database_id: databaseId,
        page_size: 100,
        start_cursor: cursor
      }),
      30000,
      `notion.databases.query(${databaseId})`
    );
    pages.push(...response.results.filter(item => item.object === 'page'));
    cursor = response.has_more ? response.next_cursor : undefined;
  } while (cursor);
  if (debug) {
    debug.databaseQueries.push({
      databaseId,
      title: label || null,
      pagesFound: pages.length,
      pageTitles: pages.map(page => getPageTitle(page) || 'Untitled section')
    });
    debug.totals.databasePagesFound += pages.length;
  }
  return pages;
}

async function listBlocks(blockId) {
  const blocks = [];
  let cursor;
  do {
    const response = await withTimeout(
      notion.blocks.children.list({
        block_id: blockId,
        page_size: 100,
        start_cursor: cursor
      }),
      30000,
      `notion.blocks.children.list(${blockId})`
    );
    blocks.push(...response.results);
    cursor = response.has_more ? response.next_cursor : undefined;
  } while (cursor);
  return blocks;
}

async function crawlContainer(containerId, context, index, sectionMap, pageMap, visitedContainers, debug) {
  const visitKey = `${context.sectionId}:${containerId}`;
  if (visitedContainers.has(visitKey)) return;
  visitedContainers.add(visitKey);

  ensureSectionRecord(sectionMap, context);
  ensurePageRecord(pageMap, context);

  const page = await safeRetrievePage(containerId);
  const pageTitle = getPageTitle(page) || context.pageTitle;
  const pageStats = ensureSyncPageStats(debug, {
    pageId: context.pageId,
    title: pageTitle,
    path: context.path.join(' / '),
    sectionId: context.sectionId
  });
  pageStats.title = pageTitle;
  pageStats.path = context.path.join(' / ');
  pageStats.visits += 1;
  pageStats.propertyTextChars = 0;
  pageStats.blockTextChars = 0;
  pageStats.blocksCount = 0;
  debug.totals.pagesVisited += 1;

  const propertyPayload = extractPagePropertyText(page);
  if (propertyPayload.text) {
    pageStats.propertyTextChars += propertyPayload.text.length;
    debug.totals.propertyTextChars += propertyPayload.text.length;
    debug.totals.chunksCreated += addTextChunks(index, context, propertyPayload.text, 'properties');
  }

  const blocks = await listBlocks(containerId);
  pageStats.blocksCount = blocks.length;
  debug.totals.blocksVisited += blocks.length;
  let order = 0;

  for (const block of blocks) {
    if (block.type === 'child_page') {
      const title = block.child_page?.title || 'Untitled page';
      const childContext = {
        sectionId: context.sectionId,
        sectionTitle: context.sectionTitle,
        pageId: block.id,
        pageTitle: title,
        path: [...context.path, title],
        depth: context.depth + 1,
        sourceTitle: context.sourceTitle,
        sourcePath: context.sourcePath,
        sectionType: 'page'
      };
      ensureSectionRecord(sectionMap, childContext);
      ensurePageRecord(pageMap, childContext);
      await crawlContainer(block.id, childContext, index, sectionMap, pageMap, visitedContainers, debug);
      continue;
    }

    if (block.type === 'child_database') {
      const nestedTitle = block.child_database?.title || 'Untitled database';
      const nestedPages = await listDatabasePages(block.id, debug, nestedTitle);
      for (const nestedPage of nestedPages) {
        const nestedPageTitle = getPageTitle(nestedPage) || 'Untitled page';
        const nestedContext = {
          sectionId: context.sectionId,
          sectionTitle: context.sectionTitle,
          pageId: nestedPage.id,
          pageTitle: nestedPageTitle,
          path: [...context.path, nestedTitle, nestedPageTitle],
          depth: context.depth + 1,
          sourceTitle: context.sourceTitle,
          sourcePath: context.sourcePath,
          sectionType: 'database'
        };
        ensureSectionRecord(sectionMap, nestedContext);
        ensurePageRecord(pageMap, nestedContext);
        await crawlContainer(nestedPage.id, nestedContext, index, sectionMap, pageMap, visitedContainers, debug);
      }
      continue;
    }

    const text = blockToText(block);
    if (text) {
      pageStats.blockTextChars += text.length;
      debug.totals.blockTextChars += text.length;
      const chunks = splitText(text, 900, 120);
      for (const chunkText of chunks) {
        index.chunks.push({
          id: `${context.pageId}:${order}:${index.chunks.length}`,
          sectionId: context.sectionId,
          sectionTitle: context.sectionTitle,
          pageId: context.pageId,
          pageTitle: context.pageTitle,
          path: context.path.join(' / '),
          sourceTitle: context.sourceTitle || context.pageTitle,
          sourcePath: context.sourcePath || context.path[0] || context.pageTitle,
          notionPageId: context.pageId,
          order: order++,
          type: block.type,
          text: chunkText
        });
        debug.totals.chunksCreated += 1;
      }
    } else if (!block.has_children) {
      recordUnsupportedBlockType(debug, block.type);
    }

    if (block.has_children) {
      await crawlNestedChildren(block.id, context, index, sectionMap, pageMap, visitedContainers, debug);
    }
  }
}

async function crawlNestedChildren(blockId, context, index, sectionMap, pageMap, visitedContainers, debug) {
  const nestedBlocks = await listBlocks(blockId);
  let nestedOrder = 0;

  for (const block of nestedBlocks) {
    if (block.type === 'child_page') {
      const title = block.child_page?.title || 'Untitled page';
      const childContext = {
        sectionId: context.sectionId,
        sectionTitle: context.sectionTitle,
        pageId: block.id,
        pageTitle: title,
        path: [...context.path, title],
        depth: context.depth + 1,
        sourceTitle: context.sourceTitle,
        sourcePath: context.sourcePath,
        sectionType: 'page'
      };
      ensureSectionRecord(sectionMap, childContext);
      ensurePageRecord(pageMap, childContext);
      await crawlContainer(block.id, childContext, index, sectionMap, pageMap, visitedContainers, debug);
      continue;
    }

    if (block.type === 'child_database') {
      const nestedTitle = block.child_database?.title || 'Untitled database';
      const nestedPages = await listDatabasePages(block.id, debug, nestedTitle);
      for (const nestedPage of nestedPages) {
        const nestedPageTitle = getPageTitle(nestedPage) || 'Untitled page';
        const nestedContext = {
          sectionId: context.sectionId,
          sectionTitle: context.sectionTitle,
          pageId: nestedPage.id,
          pageTitle: nestedPageTitle,
          path: [...context.path, nestedTitle, nestedPageTitle],
          depth: context.depth + 1,
          sourceTitle: context.sourceTitle,
          sourcePath: context.sourcePath,
          sectionType: 'database'
        };
        ensureSectionRecord(sectionMap, nestedContext);
        ensurePageRecord(pageMap, nestedContext);
        await crawlContainer(nestedPage.id, nestedContext, index, sectionMap, pageMap, visitedContainers, debug);
      }
      continue;
    }

    const text = blockToText(block);
    if (text) {
      const pageStats = ensureSyncPageStats(debug, {
        pageId: context.pageId,
        title: context.pageTitle,
        path: context.path.join(' / '),
        sectionId: context.sectionId
      });
      pageStats.blockTextChars += text.length;
      debug.totals.blockTextChars += text.length;
      const chunks = splitText(text, 900, 120);
      for (const chunkText of chunks) {
        index.chunks.push({
          id: `${context.pageId}:${nestedOrder}:${index.chunks.length}`,
          sectionId: context.sectionId,
          sectionTitle: context.sectionTitle,
          pageId: context.pageId,
          pageTitle: context.pageTitle,
          path: context.path.join(' / '),
          sourceTitle: context.sourceTitle || context.pageTitle,
          sourcePath: context.sourcePath || context.path[0] || context.pageTitle,
          notionPageId: context.pageId,
          order: nestedOrder++,
          type: block.type,
          text: chunkText
        });
        debug.totals.chunksCreated += 1;
      }
    } else if (!block.has_children) {
      recordUnsupportedBlockType(debug, block.type);
    }

    if (block.has_children) {
      await crawlNestedChildren(block.id, context, index, sectionMap, pageMap, visitedContainers, debug);
    }
  }
}

function ensurePageRecord(pageMap, context) {
  if (pageMap.has(context.pageId)) return;
  pageMap.set(context.pageId, {
    id: context.pageId,
    sectionId: context.sectionId,
    title: context.pageTitle,
    path: context.path.join(' / '),
    depth: context.depth,
    sourceTitle: context.sourceTitle || context.pageTitle,
    sourcePath: context.sourcePath || context.path[0] || context.pageTitle,
    notionPageId: context.pageId
  });
}

function ensureSectionRecord(sectionMap, context) {
  if (sectionMap.has(context.pageId)) return;
  sectionMap.set(context.pageId, {
    id: context.pageId,
    title: context.pageTitle,
    path: context.path.join(' / '),
    sectionType: context.sectionType || 'page',
    depth: context.depth,
    sourceTitle: context.sourceTitle || context.pageTitle,
    sourcePath: context.sourcePath || context.path[0] || context.pageTitle
  });
}

async function safeRetrievePage(pageId) {
  try {
    const page = await withTimeout(
      notion.pages.retrieve({ page_id: pageId }),
      30000,
      `notion.pages.retrieve(${pageId})`
    );
    return page;
  } catch (_error) {
    return null;
  }
}

function addTextChunks(index, context, text, origin) {
  const cleanText = String(text || '').replace(/\s+/g, ' ').trim();
  if (!cleanText) return 0;

  const chunks = splitText(cleanText, 900, 120);
  let created = 0;
  for (const chunkText of chunks) {
    index.chunks.push({
      id: `${context.pageId}:${origin}:${index.chunks.length}`,
      sectionId: context.sectionId,
      sectionTitle: context.sectionTitle,
      pageId: context.pageId,
      pageTitle: context.pageTitle,
      path: context.path.join(' / '),
      sourceTitle: context.sourceTitle || context.pageTitle,
      sourcePath: context.sourcePath || context.path[0] || context.pageTitle,
      notionPageId: context.pageId,
      order: index.chunks.length,
      type: origin,
      text: chunkText
    });
    created += 1;
  }
  return created;
}

function extractPagePropertyText(page) {
  const properties = page?.properties || {};
  const parts = [];
  const details = [];

  for (const [name, property] of Object.entries(properties)) {
    const value = extractPropertyTextValue(property);
    if (!value) continue;
    parts.push(`${name}: ${value}`);
    details.push({
      name,
      type: property?.type || 'unknown',
      chars: value.length
    });
  }

  const text = parts.join('\n').trim();
  return {
    text,
    chars: text.length,
    details
  };
}

function extractPropertyTextValue(property) {
  if (!property || !property.type) return '';

  switch (property.type) {
    case 'title':
      return richTextToPlain(property.title || []);
    case 'rich_text':
      return richTextToPlain(property.rich_text || []);
    case 'select':
      return property.select?.name || '';
    case 'multi_select':
      return Array.isArray(property.multi_select)
        ? property.multi_select.map(item => item?.name).filter(Boolean).join(', ')
        : '';
    case 'url':
      return property.url || '';
    case 'checkbox':
      return property.checkbox ? 'yes' : 'no';
    case 'number':
      return property.number === null || property.number === undefined ? '' : String(property.number);
    case 'date':
      if (!property.date) return '';
      if (property.date.end) return `${property.date.start || ''} - ${property.date.end}`;
      return property.date.start || '';
    case 'status':
      return property.status?.name || '';
    default:
      return '';
  }
}

function ensureSyncPageStats(debug, context) {
  if (!debug.pageStatsById.has(context.pageId)) {
    debug.pageStatsById.set(context.pageId, {
      pageId: context.pageId,
      sectionId: context.sectionId,
      title: context.title || '',
      path: context.path || '',
      blocksCount: 0,
      propertyTextChars: 0,
      blockTextChars: 0,
      visits: 0
    });
  }
  return debug.pageStatsById.get(context.pageId);
}

function createSyncDebug(sourceInfo) {
  return {
    source: {
      type: notionSourceType,
      id: notionSourceId,
      title: sourceInfo.title || '',
      path: sourceInfo.path || ''
    },
    totals: {
      databasePagesFound: 0,
      pagesVisited: 0,
      blocksVisited: 0,
      propertyTextChars: 0,
      blockTextChars: 0,
      chunksCreated: 0,
      sections: 0
    },
    databaseQueries: [],
    pageStatsById: new Map(),
    unsupportedBlockTypes: {}
  };
}

function compactSyncDebug(debug, index) {
  return {
    source: debug.source,
    totals: {
      ...debug.totals,
      sections: index.sections.length
    },
    databaseQueries: debug.databaseQueries,
    pages: Array.from(debug.pageStatsById.values()).sort((a, b) => a.path.localeCompare(b.path, 'uk')),
    unsupportedBlockTypes: debug.unsupportedBlockTypes
  };
}

function recordUnsupportedBlockType(debug, blockType) {
  if (!blockType) return;
  const ignored = new Set(['divider', 'breadcrumb', 'table_of_contents', 'link_to_page']);
  if (ignored.has(blockType)) return;
  debug.unsupportedBlockTypes[blockType] = (debug.unsupportedBlockTypes[blockType] || 0) + 1;
}

function getPageTitle(page) {
  const properties = page?.properties || {};
  for (const property of Object.values(properties)) {
    if (property?.type === 'title' && Array.isArray(property.title)) {
      const title = richTextToPlain(property.title);
      if (title) return title;
    }
  }
  if (page?.title && Array.isArray(page.title)) {
    const title = richTextToPlain(page.title);
    if (title) return title;
  }
  return page?.properties?.title?.title ? richTextToPlain(page.properties.title.title) : '';
}

function richTextToPlain(richText = []) {
  return richText
    .map(part => part.plain_text || '')
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
}

function blockToText(block) {
  if (!block || !block.type) return '';
  const value = block[block.type];
  if (!value) return '';

  const richTextTypes = new Set([
    'paragraph',
    'heading_1',
    'heading_2',
    'heading_3',
    'quote',
    'callout',
    'bulleted_list_item',
    'numbered_list_item',
    'to_do',
    'toggle',
    'code',
    'caption'
  ]);

  if (richTextTypes.has(block.type)) {
    const text = richTextToPlain(value.rich_text || value.caption || []);
    if (text) return text;
  }

  if (block.type === 'image' && value.caption) {
    return richTextToPlain(value.caption);
  }

  if (block.type === 'embed' && value.url) {
    return value.url;
  }

  return '';
}

function splitText(text, maxChars = 900, overlap = 120) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (!clean) return [];
  if (clean.length <= maxChars) return [clean];

  const chunks = [];
  let start = 0;
  while (start < clean.length) {
    let end = Math.min(start + maxChars, clean.length);
    if (end < clean.length) {
      const minSearchStart = start + Math.floor(maxChars * 0.5);
      let sentenceEnd = -1;
      for (let i = end - 1; i >= minSearchStart; i--) {
        const char = clean[i];
        const nextChar = clean[i + 1];
        if ((char === '.' || char === '?' || char === '!') && nextChar === ' ') {
          sentenceEnd = i + 1;
          break;
        }
      }
      if (sentenceEnd !== -1) {
        end = sentenceEnd;
      } else {
        const breakPoint = clean.lastIndexOf(' ', end);
        if (breakPoint > start + Math.floor(maxChars * 0.6)) {
          end = breakPoint;
        }
      }
    }

    const chunk = clean.slice(start, end).trim();
    if (chunk) chunks.push(chunk);
    if (end >= clean.length) break;
    start = Math.max(end - overlap, start + 1);
  }
  return chunks;
}

async function answerFromIndex({ index, question, section = null, language, debug = false, mode: providedMode = null }) {
  const fallback = getFallbackAnswer(language);
  const mode = providedMode || buildQuestionMode(question);
  const retrievalQueries = buildRetrievalQueries(question, mode, language);
  const isCompoundQuestion = retrievalQueries.length > 1;
  const sectionLimit = getRetrievalSectionLimit(question, language, mode);
  const resolvedSection = section || null;
  const sectionPlanLimit = Math.max(3, Math.ceil(sectionLimit / Math.max(1, retrievalQueries.length)));
  const queryPlans = retrievalQueries.map(queryPlan => {
    const plannedSections = resolvedSection
      ? (isBroadRootSection(resolvedSection)
          ? selectRelevantSections(index, queryPlan.hint, sectionPlanLimit, mode)
          : [resolvedSection, ...selectRelevantSections(index, queryPlan.hint, Math.max(2, sectionPlanLimit - 1), mode).filter(item => item.id !== resolvedSection.id)])
      : selectRelevantSections(index, queryPlan.hint, sectionPlanLimit, mode);
    const plannedSectionChunks = collectChunksForSections(index, plannedSections);
     const rankedChunks = rankChunks(queryPlan.hint, plannedSectionChunks, mode);
     const maxPageScores = new Map();
     for (const chunk of rankedChunks) {
       const pageId = chunk.pageId;
       if (pageId) {
         const currentMax = maxPageScores.get(pageId) || 0;
         if (chunk.score > currentMax) {
           maxPageScores.set(pageId, chunk.score);
         }
       }
     }
     const boostedChunks = rankedChunks.map(chunk => {
       const pageId = chunk.pageId;
       const maxScore = maxPageScores.get(pageId) || 0;
       let boost = 0;
       if (maxScore >= 10) {
         boost = Math.floor(maxScore * 0.5);
         const cleanText = String(chunk.text || '').trim();
         const isBullet = cleanText.startsWith('—') || cleanText.startsWith('-') || cleanText.startsWith('*') || cleanText.startsWith('•');
         if (isBullet) {
           boost += 8;
         }
       }
       return {
         ...chunk,
         score: chunk.score + boost
       };
     }).sort((a, b) => b.score - a.score);
     const balancedChunks = balanceChunksBySection(boostedChunks, plannedSections, isCompoundQuestion ? 18 : 15).slice(0, isCompoundQuestion ? 120 : 100);
     return {
       ...queryPlan,
       sections: plannedSections,
       chunks: balancedChunks
     };
  });

  const sectionMap = new Map();
  if (resolvedSection) {
    sectionMap.set(resolvedSection.id, resolvedSection);
  }
  for (const plan of queryPlans) {
    for (const plannedSection of plan.sections) {
      if (!sectionMap.has(plannedSection.id)) {
        sectionMap.set(plannedSection.id, plannedSection);
      }
    }
  }

  let selectedSections = Array.from(sectionMap.values());
  if (!selectedSections.length) {
    selectedSections = selectRelevantSections(index, retrievalQueries[0]?.hint || question, sectionLimit, mode);
  }

  let sectionChunks = dedupeChunks(queryPlans.flatMap(plan => plan.chunks));
  const rankedByQuery = queryPlans.map(queryPlan => rankChunks(queryPlan.hint, sectionChunks.length ? sectionChunks : collectChunksForSections(index, selectedSections), mode));
  const combinedRankMap = new Map();

  for (const rankedList of rankedByQuery) {
    for (const chunk of rankedList) {
      const key = `${chunk.pageId}|${chunk.path}|${chunk.text}`;
      const current = combinedRankMap.get(key) || { ...chunk, score: 0, queryHits: 0 };
      current.score += chunk.score;
      current.queryHits += 1;
      combinedRankMap.set(key, current);
    }
  }

  const baseRanked = Array.from(combinedRankMap.values())
    .map(chunk => ({
      ...chunk,
      score: chunk.score + Math.min(6, Math.max(0, chunk.queryHits - 1) * 2)
    }));

  const maxPageScores = new Map();
  for (const chunk of baseRanked) {
    const pageId = chunk.pageId;
    if (pageId) {
      const currentMax = maxPageScores.get(pageId) || 0;
      if (chunk.score > currentMax) {
        maxPageScores.set(pageId, chunk.score);
      }
    }
  }

  const rankedAll = baseRanked.map(chunk => {
    const pageId = chunk.pageId;
    const maxScore = maxPageScores.get(pageId) || 0;
    let boost = 0;
    if (maxScore >= 10) {
      boost = Math.floor(maxScore * 0.5);
      const cleanText = String(chunk.text || '').trim();
      const isBullet = cleanText.startsWith('—') || cleanText.startsWith('-') || cleanText.startsWith('*') || cleanText.startsWith('•');
      if (isBullet) {
        boost += 8;
      }
    }
    return {
      ...chunk,
      score: chunk.score + boost
    };
  }).sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const aText = `${a.pageTitle || ''} ${a.path || ''}`.toLowerCase();
    const bText = `${b.pageTitle || ''} ${b.path || ''}`.toLowerCase();
    return aText.localeCompare(bText, 'uk');
  });

  let ranked = balanceChunksBySection(rankedAll, selectedSections, isCompoundQuestion ? 18 : 15).slice(0, isCompoundQuestion ? 80 : 60);
  const contextPool = dedupeChunks(ranked);
  let matchedSection = resolvedSection || selectedSections[0] || null;

  if (!ranked.length && !section) {
    sectionChunks = index.chunks;
    const fallbackRankedByQuery = queryPlans.map(queryPlan => rankChunks(queryPlan.hint, sectionChunks, mode));
    const fallbackRankMap = new Map();
    for (const rankedList of fallbackRankedByQuery) {
      for (const chunk of rankedList) {
        const key = `${chunk.pageId}|${chunk.path}|${chunk.text}`;
        const current = fallbackRankMap.get(key) || { ...chunk, score: 0, queryHits: 0 };
        current.score += chunk.score;
        current.queryHits += 1;
        fallbackRankMap.set(key, current);
      }
    }
    const baseFallbackRanked = Array.from(fallbackRankMap.values())
      .map(chunk => ({
        ...chunk,
        score: chunk.score + Math.min(6, Math.max(0, chunk.queryHits - 1) * 2)
      }));

    const maxFallbackPageScores = new Map();
    for (const chunk of baseFallbackRanked) {
      const pageId = chunk.pageId;
      if (pageId) {
        const currentMax = maxFallbackPageScores.get(pageId) || 0;
        if (chunk.score > currentMax) {
          maxFallbackPageScores.set(pageId, chunk.score);
        }
      }
    }

    const fallbackRankedAll = baseFallbackRanked.map(chunk => {
      const pageId = chunk.pageId;
      const maxScore = maxFallbackPageScores.get(pageId) || 0;
      let boost = 0;
      if (maxScore >= 10) {
        boost = Math.floor(maxScore * 0.5);
        const cleanText = String(chunk.text || '').trim();
        const isBullet = cleanText.startsWith('—') || cleanText.startsWith('-') || cleanText.startsWith('*') || cleanText.startsWith('•');
        if (isBullet) {
          boost += 8;
        }
      }
      return {
        ...chunk,
        score: chunk.score + boost
      };
    }).sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      const aText = `${a.pageTitle || ''} ${a.path || ''}`.toLowerCase();
      const bText = `${b.pageTitle || ''} ${b.path || ''}`.toLowerCase();
      return aText.localeCompare(bText, 'uk');
    });

    ranked = balanceChunksBySection(fallbackRankedAll, selectedSections, isCompoundQuestion ? 18 : 15).slice(0, isCompoundQuestion ? 80 : 60);
    contextPool.splice(0, contextPool.length, ...dedupeChunks(ranked));
  }

  const contextChunks = buildContextChunks(contextPool.length ? contextPool : (ranked.length ? ranked : sectionChunks), isCompoundQuestion ? 60 : 50, isCompoundQuestion ? 60000 : 50000);
  const sourceChunks = dedupeSources(contextChunks);

  if (!contextChunks.length) {
    const safeClientReply = mode === 'client_reply' ? getSafeClientReply(language) : fallback;
    const payload = {
      answer: safeClientReply,
      sources: []
    };
    if (debug) {
      payload.debug = {
        selectedSections: selectedSections.map(sectionItem => ({
          id: sectionItem.id,
          title: sectionItem.title,
          path: sectionItem.path,
          sectionType: sectionItem.sectionType
        })),
        retrievalQueries: retrievalQueries.map(queryPlan => queryPlan.part),
        contextChunkCount: 0,
        contextChars: 0,
        contextChunks: []
      };
    }
    return payload;
  }

  const context = contextChunks
    .map((chunk, idx) => `SOURCE ${idx + 1}\nPAGE: ${chunk.pageTitle}\nPATH: ${chunk.path}\nTEXT: ${chunk.text}`)
    .join('\n\n---\n\n');
  const groundedAnswer = buildGroundedAnswer(contextChunks);
  const replyTerms = mode === 'client_reply' ? (getIntentTerms(language).client_reply || []).map(term => normalize(term)) : [];
  const hasReplyContext = mode !== 'client_reply' || contextChunks.some(chunk => {
    const text = normalize(`${chunk.pageTitle || ''} ${chunk.path || ''} ${chunk.text || ''}`);
    return replyTerms.some(term => term && text.includes(term));
  });

  if (mode === 'client_reply' && !hasReplyContext) {
    const payload = {
      answer: getSafeClientReply(language),
      sources: sourceChunks.map(chunk => ({
        title: chunk.pageTitle,
        path: chunk.path,
        snippet: makeSnippet(chunk.text, 380),
        pageId: chunk.pageId,
        sectionId: chunk.sectionId,
        sectionTitle: chunk.sectionTitle,
        score: chunk.score
      }))
    };
    if (debug) {
      payload.debug = {
        selectedSections: selectedSections.map(sectionItem => ({
          id: sectionItem.id,
          title: sectionItem.title,
          path: sectionItem.path,
          sectionType: sectionItem.sectionType
        })),
        contextChunkCount: contextChunks.length,
        contextChars: context.length,
        contextChunks: contextChunks.map((chunk, idx) => ({
          index: idx + 1,
          pageTitle: chunk.pageTitle,
          path: chunk.path,
          sectionTitle: chunk.sectionTitle,
          sectionId: chunk.sectionId,
          score: chunk.score,
          snippet: makeSnippet(chunk.text, 220),
          text: chunk.text
        }))
      };
    }
    return payload;
  }

  if (!hasGemini()) {
    throw new Error('Set AI_PROVIDER=gemini and provide GEMINI_API_KEY to answer questions.');
  }

  let answer;
  try {
    answer = await generateGeminiAnswerV2({ question, context, language, fallback, mode });
  } catch (error) {
    const details = formatErrorDetails(error);
    console.error('[api/ask-gemini]', `${details.name}: ${details.message}`);
    answer = mode === 'client_reply'
      ? getSafeClientReply(language)
      : (groundedAnswer || fallback);
  }
  const cleanAnswer = String(answer || '').trim() || fallback;
  matchedSection = matchedSection || index.sections.find(item => item.id === (ranked[0]?.sectionId || contextChunks[0]?.sectionId)) || null;
  const matchedTitle = !section
    ? (sourceChunks[0]?.pageTitle || matchedSection?.title || null)
    : (matchedSection?.title || sourceChunks[0]?.pageTitle || null);
  let finalAnswer = selectFinalAnswer({
    mode,
    cleanAnswer,
    fallback,
    groundedAnswer,
    language
  });
  finalAnswer = augmentAnswerWithQualifierNote({
    question,
    answer: finalAnswer,
    sources: sourceChunks,
    language,
    mode
  });

  const debugInfo = debug ? {
    questionMode: mode,
    normalizedQuestion: normalizeIntentText(question),
    selectedSections: selectedSections.map(sectionItem => ({
      id: sectionItem.id,
      title: sectionItem.title,
      path: sectionItem.path,
      sectionType: sectionItem.sectionType
    })),
    retrievalQueries: retrievalQueries.map(queryPlan => queryPlan.part),
    contextChunkCount: contextChunks.length,
    contextChars: context.length,
    contextChunks: contextChunks.map((chunk, idx) => ({
      index: idx + 1,
      pageTitle: chunk.pageTitle,
      path: chunk.path,
      sectionTitle: chunk.sectionTitle,
      sectionId: chunk.sectionId,
      score: chunk.score,
      snippet: makeSnippet(chunk.text, 220),
      text: chunk.text
    }))
  } : null;

  if (finalAnswer === fallback) {
    if (groundedAnswer) {
      const payload = {
        answer: groundedAnswer,
        sources: sourceChunks.map(chunk => ({
          title: chunk.pageTitle,
          path: chunk.path,
          snippet: makeSnippet(chunk.text, 380),
          pageId: chunk.pageId,
          sectionId: chunk.sectionId,
          sectionTitle: chunk.sectionTitle,
          score: chunk.score
        }))
      };
      if (debugInfo) payload.debug = debugInfo;
      return payload;
    }
    const payload = {
      answer: fallback,
      sources: sourceChunks.map(chunk => ({
        title: chunk.pageTitle,
        path: chunk.path,
        snippet: makeSnippet(chunk.text, 380),
        pageId: chunk.pageId,
        sectionId: chunk.sectionId,
        sectionTitle: chunk.sectionTitle,
        score: chunk.score
      }))
    };
    if (debugInfo) payload.debug = debugInfo;
    return payload;
  }

  const sources = sourceChunks.map(chunk => ({
    title: chunk.pageTitle,
    path: chunk.path,
    snippet: makeSnippet(chunk.text, 380),
    pageId: chunk.pageId,
    sectionId: chunk.sectionId,
    sectionTitle: chunk.sectionTitle,
    score: chunk.score
  }));

  return {
    answer: finalAnswer,
    sources,
    ...(debugInfo ? { debug: debugInfo } : {})
  };
}

function rankChunks(question, chunks, mode = 'fact') {
  const tokens = tokenize(question);
  const query = normalize(question);
  const intents = mode === 'client_reply' ? detectRetrievalIntents(question, null, mode) : [];
  const intentTerms = mode === 'client_reply' ? getIntentTerms() : {};
  return chunks
    .map(chunk => {
      const text = normalize(`${chunk.pageTitle} ${chunk.path} ${chunk.text}`);
      let score = 0;
      if (text.includes(query) && query.length > 4) score += 20;
      for (const token of tokens) {
        if (text.includes(token)) {
          score += token.length >= 6 ? 4 : 2;
        }
      }
      for (const intent of intents) {
        const terms = intentTerms[intent] || [];
        for (const term of terms) {
          if (text.includes(normalize(term))) {
            score += term.length > 8 ? 3 : 2;
          }
        }
      }
      if (mode === 'client_reply') {
        const replyTerms = (getIntentTerms().client_reply || []).map(term => normalize(term));
        if (replyTerms.some(term => term && text.includes(term))) {
          score += 10;
        } else {
          score -= 4;
        }
      }
      if (text.includes('no answer')) score -= 1;
      return { ...chunk, score };
    })
    .filter(chunk => chunk.score > 0)
    .sort((a, b) => b.score - a.score);
}

function dedupeSources(chunks) {
  const seen = new Set();
  return chunks.filter(chunk => {
    if (seen.has(chunk.pageId)) return false;
    seen.add(chunk.pageId);
    return true;
  });
}

function detectQuestionMode(question) {
  return isClientReplyQuestion(question) ? 'client_reply' : 'fact';
}

function buildRetrievalQuestion(question, mode) {
  if (mode !== 'client_reply') return question;
  return [
    question,
    'шаблон сообщения',
    'ответ клиенту',
    'готовый ответ',
    'после звонка',
    'ready-made reply',
    'client message'
  ].join(' ');
}

function selectFinalAnswer({ mode, cleanAnswer, fallback, groundedAnswer, language }) {
  const normalizedClean = normalize(cleanAnswer);
  const safeClientReply = getSafeClientReply(language);

  if (mode === 'client_reply') {
    return safeClientReply;
  }

  if (normalizedClean === normalize(fallback) && groundedAnswer) {
    return groundedAnswer;
  }

  return cleanAnswer;
}

function isClientReplyQuestion(question) {
  const normalizedQuestion = normalizeIntentText(question);
  if (!normalizedQuestion) return false;

  const phraseMarkers = [
    'что ответить',
    'как ответить',
    'що відповісти',
    'як відповісти',
    'клиент написал',
    'клієнт написав',
    'the customer wrote',
    'customer wrote',
    'client wrote',
    'how should i respond',
    'what should i reply',
    'how to reply',
    'what should we reply',
    'what to reply',
    'how should we reply',
    'reply to the customer',
    'reply to the client',
    'send to the client'
  ];

  if (phraseMarkers.some(marker => normalizedQuestion.includes(normalizeIntentText(marker)))) {
    return true;
  }

  const subjectMarkers = ['клієнт', 'клиент', 'customer', 'client'];
  const replyMarkers = ['написав', 'написала', 'написал', 'wrote', 'ответить', 'как ответить', 'что ответить', 'відповісти', 'що відповісти', 'як відповісти', 'reply', 'respond'];

  const hasSubject = subjectMarkers.some(marker => normalizedQuestion.includes(marker));
  const hasReplyVerb = replyMarkers.some(marker => normalizedQuestion.includes(normalizeIntentText(marker)));
  if (hasSubject && hasReplyVerb) return true;

  const contextualMarkers = [
    /(?:^|\b)(?:клієнт|клиент|customer|client)\b[\s\S]{0,40}?\b(?:написав|написала|написал|wrote)\b/i,
    /\b(?:what should i respond|how should i respond|what should i reply|how to reply)\b/i,
    /\b(?:reply to the customer|reply to the client|send to the client)\b/i
  ];

  return contextualMarkers.some(pattern => pattern.test(question));
}

function buildQuestionMode(question) {
  return isClientReplyQuestion(question) ? 'client_reply' : 'fact';
}

function getQuestionTokensForDecomposition(question) {
  return tokenize(question).filter(Boolean);
}

function splitCompoundClause(clause) {
  const clean = String(clause || '').replace(/\s+/g, ' ').trim();
  if (!clean) return [];

  const connectorPattern = /\s+(?:and|also|plus|и|і|й|та|а|ще|також)\s+/i;
  const hasConnector = connectorPattern.test(clean);
  if (!hasConnector) return [clean];

  const openerPattern = /(?:^|\b)(?:can|could|should|would|may|might|want|need|want to|need to|хочу|хотів би|хотіла б|хотіли б|можно|можна|можно ли|чи можна|чи можливо|нужно|потрібно|могу|можу|сколько|скільки|how much|how long|what|which|when|where|why|is|are|do|does|did)\b/i;
  if (!openerPattern.test(clean)) return [clean];

  const pieces = clean
    .split(connectorPattern)
    .map(piece => piece.trim())
    .filter(Boolean);

  if (pieces.length <= 1) return [clean];

  const hasMeaningfulPieces = pieces.every(piece => getQuestionTokensForDecomposition(piece).length >= 2 || piece.length >= 12);
  return hasMeaningfulPieces ? pieces : [clean];
}

function decomposeQuestion(question, mode) {
  const clean = String(question || '').replace(/\r/g, '\n').trim();
  if (!clean) return [];
  if (mode === 'client_reply') return [clean];

  const sentenceParts = clean
    .split(/\n+|(?<=[?!.;])\s+/u)
    .map(part => part.trim())
    .filter(Boolean);

  const pieces = [];
  for (const sentence of sentenceParts.length ? sentenceParts : [clean]) {
    const splitPieces = splitCompoundClause(sentence);
    for (const piece of splitPieces) {
      const trimmed = piece.trim();
      if (!trimmed) continue;
      pieces.push(trimmed);
    }
  }

  const unique = [];
  const seen = new Set();
  for (const piece of pieces.length ? pieces : [clean]) {
    const normalized = normalize(piece);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    unique.push(piece);
  }

  const meaningful = unique.filter(piece => {
    const tokenCount = getQuestionTokensForDecomposition(piece).length;
    return tokenCount >= 2 || piece.length >= 10;
  });

  if (!meaningful.length) return [clean];
  if (meaningful.length <= 5) return meaningful;

  const [first, ...rest] = meaningful;
  return [first, ...rest.sort((a, b) => b.length - a.length).slice(0, 4)];
}

function buildRetrievalQueries(question, mode, language) {
  const parts = decomposeQuestion(question, mode);
  const queries = parts.length > 1 ? [question, ...parts] : [question];
  const unique = [];
  const seen = new Set();

  for (const part of queries) {
    const hint = buildRetrievalHint(part, mode, language);
    const normalized = normalize(hint);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    unique.push({
      part: String(part || '').trim(),
      hint
    });
  }

  return unique.length ? unique : [{ part: String(question || '').trim(), hint: buildRetrievalHint(question, mode, language) }];
}

function dedupeSections(sections) {
  const seen = new Set();
  const unique = [];
  for (const section of Array.isArray(sections) ? sections : []) {
    if (!section || !section.id || seen.has(section.id)) continue;
    seen.add(section.id);
    unique.push(section);
  }
  return unique;
}

function splitSectionPath(value) {
  return String(value || '')
    .split(/\s*\/\s*/u)
    .map(segment => normalize(segment))
    .filter(Boolean);
}

function countSharedPathPrefix(pathA, pathB) {
  const aParts = Array.isArray(pathA) ? pathA : splitSectionPath(pathA);
  const bParts = Array.isArray(pathB) ? pathB : splitSectionPath(pathB);
  const length = Math.min(aParts.length, bParts.length);
  let count = 0;
  for (let index = 0; index < length; index += 1) {
    if (aParts[index] !== bParts[index]) break;
    count += 1;
  }
  return count;
}

function scoreSectionNeighborhood(candidate, seedSections) {
  if (!candidate || !Array.isArray(seedSections) || !seedSections.length) return 0;

  const candidatePath = splitSectionPath(candidate.path || candidate.title);
  const candidateText = normalize(`${candidate.title || ''} ${candidate.path || ''}`);
  const candidateTokens = tokenize(`${candidate.title || ''} ${candidate.path || ''}`);
  let best = 0;

  for (const seed of seedSections) {
    if (!seed) continue;
    if (seed.id === candidate.id) return 1000;

    const seedPath = splitSectionPath(seed.path || seed.title);
    const seedTokens = tokenize(`${seed.title || ''} ${seed.path || ''}`);
    const sharedPrefix = countSharedPathPrefix(candidatePath, seedPath);

    let score = sharedPrefix * 12;
    if (sharedPrefix && (candidatePath.length === sharedPrefix || seedPath.length === sharedPrefix)) {
      score += 8;
    }

    if (candidatePath[0] && seedPath[0] && candidatePath[0] === seedPath[0]) {
      score += 4;
    }

    if (normalize(candidate.path || candidate.title) === normalize(seed.path || seed.title)) {
      score += 20;
    }

    let tokenOverlap = 0;
    for (const token of seedTokens) {
      if (!token) continue;
      if (candidateTokens.includes(token)) {
        tokenOverlap += token.length >= 6 ? 3 : 2;
      } else if (candidateText.includes(token)) {
        tokenOverlap += token.length >= 6 ? 2 : 1;
      }
    }

    score += Math.min(18, tokenOverlap);
    score += Math.max(0, 4 - Math.abs(Number(candidate.depth || 0) - Number(seed.depth || 0)));
    best = Math.max(best, score);
  }

  return best;
}

function getRelatedSections(index, seedSections, limit = 6) {
  const seeds = dedupeSections(seedSections);
  if (!Array.isArray(index?.sections) || !index.sections.length || !seeds.length) return [];

  return index.sections
    .map(section => ({
      ...section,
      score: scoreSectionNeighborhood(section, seeds)
    }))
    .filter(section => section.score > 0 && !seeds.some(seed => seed.id === section.id))
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (a.path === b.path) return a.id.localeCompare(b.id, 'uk');
      return String(a.path || '').localeCompare(String(b.path || ''), 'uk');
    })
    .slice(0, limit)
    .map(({ score, ...section }) => section);
}

function buildSectionExpansionQuery(sections, retrievalQueries) {
  const parts = [];
  const seen = new Set();

  const pushValue = value => {
    const clean = String(value || '').trim();
    const normalized = normalize(clean);
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    parts.push(clean);
  };

  for (const section of dedupeSections(sections)) {
    pushValue(section.title);
    pushValue(section.path);
  }

  for (const queryPlan of Array.isArray(retrievalQueries) ? retrievalQueries : []) {
    pushValue(queryPlan?.hint);
  }

  return parts.join(' ').trim();
}

function evaluateRetrievalStrength({ selectedSections, rankedAll, contextChunks, mode }) {
  const sectionCount = Array.isArray(selectedSections) ? selectedSections.length : 0;
  const chunkCount = Array.isArray(contextChunks) ? contextChunks.length : 0;
  const uniqueSectionCount = new Set((Array.isArray(contextChunks) ? contextChunks : []).map(chunk => chunk.sectionId)).size;
  const uniquePageCount = new Set((Array.isArray(contextChunks) ? contextChunks : []).map(chunk => chunk.pageId)).size;
  const topScores = Array.isArray(rankedAll) ? rankedAll.slice(0, 8).map(chunk => Number(chunk.score || 0)) : [];
  const topScore = topScores[0] || 0;
  const totalTopScore = topScores.reduce((sum, score) => sum + score, 0);
  const reasons = [];

  if (!chunkCount) reasons.push('no_context');
  if (chunkCount > 0 && chunkCount < 5) reasons.push('few_chunks');
  if (topScore < 12) reasons.push('low_top_score');
  if (totalTopScore < 40) reasons.push('low_total_score');
  if (uniqueSectionCount < 2 && chunkCount < 8) reasons.push('narrow_section_coverage');
  if (uniquePageCount < 2 && chunkCount < 8) reasons.push('narrow_page_coverage');
  if (mode === 'client_reply' && chunkCount < 4) reasons.push('reply_context_sparse');
  if (sectionCount === 0) reasons.push('no_selected_sections');

  return {
    weak: reasons.length > 0,
    reason: reasons.join(', '),
    sectionCount,
    chunkCount,
    uniqueSectionCount,
    uniquePageCount,
    topScore,
    totalTopScore
  };
}

function buildSecondPassSections(index, selectedSections, retrievalQueries, mode, sectionLimit) {
  const baseSections = dedupeSections(
    Array.isArray(selectedSections) && selectedSections.length
      ? selectedSections
      : selectRelevantSections(index, retrievalQueries[0]?.hint || '', sectionLimit, mode)
  );

  const expansionLimit = Math.min(
    Math.max(sectionLimit + 5, baseSections.length + 4),
    Math.max(6, Math.min(Array.isArray(index?.sections) ? index.sections.length : 0, sectionLimit + 10))
  );
  const expansionQuery = buildSectionExpansionQuery(baseSections, retrievalQueries);
  const querySections = expansionQuery
    ? selectRelevantSections(index, expansionQuery, expansionLimit, mode)
    : [];
  const relatedSections = getRelatedSections(index, baseSections, expansionLimit);

  return dedupeSections([...baseSections, ...querySections, ...relatedSections]).slice(0, expansionLimit);
}

function buildRetrievalPass({
  index,
  question,
  mode,
  language,
  retrievalQueries,
  seedSections = [],
  sectionLimit = 5,
  sectionPlanLimit = null,
  perSectionLimit = 4,
  balancedLimit = 60,
  contextChunkLimit = 18,
  contextCharLimit = 18000
}) {
  const seedList = dedupeSections(seedSections);
  const effectiveSectionPlanLimit = sectionPlanLimit || Math.max(3, Math.ceil(sectionLimit / Math.max(1, retrievalQueries.length || 1)));
  const queryPlans = retrievalQueries.map(queryPlan => {
    const plannedSections = seedList.length
      ? dedupeSections([
          ...seedList,
          ...selectRelevantSections(index, queryPlan.hint, effectiveSectionPlanLimit, mode)
        ])
      : selectRelevantSections(index, queryPlan.hint, effectiveSectionPlanLimit, mode);
    const plannedSectionChunks = collectChunksForSections(index, plannedSections);
    const rankedChunks = rankChunks(queryPlan.hint, plannedSectionChunks, mode);
    const balancedChunks = balanceChunksBySection(rankedChunks, plannedSections, 4).slice(0, 16);
    return {
      ...queryPlan,
      sections: plannedSections,
      chunks: balancedChunks
    };
  });

  const sectionMap = new Map();
  for (const section of seedList) {
    sectionMap.set(section.id, section);
  }
  for (const plan of queryPlans) {
    for (const plannedSection of plan.sections) {
      if (!sectionMap.has(plannedSection.id)) {
        sectionMap.set(plannedSection.id, plannedSection);
      }
    }
  }

  let selectedSections = Array.from(sectionMap.values());
  if (!selectedSections.length) {
    selectedSections = selectRelevantSections(index, retrievalQueries[0]?.hint || question, sectionLimit, mode);
  }

  let sectionChunks = dedupeChunks(queryPlans.flatMap(plan => plan.chunks));
  const rankedByQuery = queryPlans.map(queryPlan => rankChunks(queryPlan.hint, sectionChunks.length ? sectionChunks : collectChunksForSections(index, selectedSections), mode));
  const combinedRankMap = new Map();

  for (const rankedList of rankedByQuery) {
    for (const chunk of rankedList) {
      const key = `${chunk.pageId}|${chunk.path}|${chunk.text}`;
      const current = combinedRankMap.get(key) || { ...chunk, score: 0, queryHits: 0 };
      current.score += chunk.score;
      current.queryHits += 1;
      combinedRankMap.set(key, current);
    }
  }

  const rankedAll = Array.from(combinedRankMap.values())
    .map(chunk => ({
      ...chunk,
      score: chunk.score + Math.min(6, Math.max(0, chunk.queryHits - 1) * 2)
    }))
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      const aText = `${a.pageTitle || ''} ${a.path || ''}`.toLowerCase();
      const bText = `${b.pageTitle || ''} ${b.path || ''}`.toLowerCase();
      return aText.localeCompare(bText, 'uk');
    });

  let ranked = balanceChunksBySection(rankedAll, selectedSections, perSectionLimit).slice(0, balancedLimit);
  const topicChunks = selectTopicChunks(rankedAll.length ? rankedAll : sectionChunks, question, language);
  const contextPool = dedupeChunks(
    mode === 'client_reply' && topicChunks.length
      ? [...topicChunks, ...ranked]
      : [...topicChunks, ...ranked]
  );
  let matchedSection = seedList[0] || selectedSections[0] || null;

  if (!ranked.length && !seedList.length) {
    sectionChunks = index.chunks;
    const fallbackRankedByQuery = queryPlans.map(queryPlan => rankChunks(queryPlan.hint, sectionChunks, mode));
    const fallbackRankMap = new Map();
    for (const rankedList of fallbackRankedByQuery) {
      for (const chunk of rankedList) {
        const key = `${chunk.pageId}|${chunk.path}|${chunk.text}`;
        const current = fallbackRankMap.get(key) || { ...chunk, score: 0, queryHits: 0 };
        current.score += chunk.score;
        current.queryHits += 1;
        fallbackRankMap.set(key, current);
      }
    }
    const fallbackRankedAll = Array.from(fallbackRankMap.values())
      .map(chunk => ({
        ...chunk,
        score: chunk.score + Math.min(6, Math.max(0, chunk.queryHits - 1) * 2)
      }))
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        const aText = `${a.pageTitle || ''} ${a.path || ''}`.toLowerCase();
        const bText = `${b.pageTitle || ''} ${b.path || ''}`.toLowerCase();
        return aText.localeCompare(bText, 'uk');
      });
    ranked = balanceChunksBySection(fallbackRankedAll, selectedSections, perSectionLimit).slice(0, balancedLimit);
    const fallbackTopicChunks = selectTopicChunks(fallbackRankedAll.length ? fallbackRankedAll : sectionChunks, question, language);
    contextPool.splice(0, contextPool.length, ...dedupeChunks([...fallbackTopicChunks, ...ranked]));
  }

  const contextChunks = buildContextChunks(contextPool.length ? contextPool : (ranked.length ? ranked : sectionChunks), contextChunkLimit, contextCharLimit);

  return {
    queryPlans,
    selectedSections,
    sectionChunks,
    rankedAll,
    ranked,
    topicChunks,
    contextPool,
    contextChunks,
    matchedSection
  };
}

function buildRetrievalHint(question, mode, language) {
  const parts = [question];

  if (mode === 'client_reply') {
    parts.push(
      'що відповісти',
      'як відповісти',
      'ответ клиенту',
      'клієнт написав',
      'готовый ответ',
      'шаблон сообщения',
      'ready-made reply',
      'client message'
    );
    return parts.join(' ');
  }

  const expandedTerms = getCrossLanguageRetrievalTerms(language);
  if (expandedTerms.length) {
    parts.push(...expandedTerms);
  }

  return parts.join(' ');
}

function getRetrievalSectionLimit(question, language, mode) {
  if (mode === 'client_reply') return 8;

  const matchedGroups = detectRetrievalIntents(question, language, mode).length;

  if (matchedGroups >= 2) return 14;
  if (matchedGroups === 1) return 12;
  return 10;
}

function selectTopicChunks(chunks, question, language, maxPerTopic = 4) {
  if (!Array.isArray(chunks) || !chunks.length) return [];
  const text = normalize(`${question || ''} ${language || ''}`);
  const topics = getRetrievalTopics(language);
  let activeTopics = topics.filter(topic => topic.terms.some(term => text.includes(normalize(term))));
  if (text.includes('клієнт написав') || text.includes('що відповісти') || text.includes('як відповісти') || text.includes('what to reply') || text.includes('what should we reply') || text.includes('reply to the client') || text.includes('client wrote')) {
    activeTopics = topics.filter(topic => topic.key === 'client_reply');
  }
  if (!activeTopics.length) return [];

  const selected = [];
  const seen = new Set();

  for (const topic of activeTopics) {
    const topicMatches = chunks
      .map(chunk => ({ chunk, score: scoreTopicChunk(chunk, topic) }))
      .filter(item => item.score > 0)
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        const aText = `${a.chunk.pageTitle || ''} ${a.chunk.path || ''}`.toLowerCase();
        const bText = `${b.chunk.pageTitle || ''} ${b.chunk.path || ''}`.toLowerCase();
        return aText.localeCompare(bText, 'uk');
      })
      .slice(0, maxPerTopic)
      .map(item => item.chunk);

    for (const chunk of topicMatches) {
      const key = `${chunk.pageId}|${chunk.path}|${chunk.text}`;
      if (seen.has(key)) continue;
      seen.add(key);
      selected.push(chunk);
    }
  }

  return selected;
}

function scoreTopicChunk(chunk, topic) {
  const rawText = String(`${chunk.pageTitle || ''} ${chunk.path || ''} ${chunk.text || ''}`);
  const haystack = normalize(rawText);
  const topicTerms = Array.isArray(topic?.terms) ? topic.terms : [];
  let score = 0;
  for (const term of topicTerms) {
    const normalizedTerm = normalize(term);
    if (!normalizedTerm) continue;
    if (haystack.includes(normalizedTerm)) {
      score += 1;
    }
  }
  return score;
}

function balanceChunksBySection(chunks, selectedSections, perSectionLimit = 6) {
  if (!Array.isArray(chunks) || !chunks.length) return [];
  const selectedSectionIds = new Set((Array.isArray(selectedSections) ? selectedSections : []).map(section => section.id));
  const selectedPaths = (Array.isArray(selectedSections) ? selectedSections : [])
    .map(section => String(section.path || section.title || '').trim())
    .filter(Boolean);
  const counts = new Map();
  const balanced = [];

  for (const chunk of chunks) {
    const chunkPath = String(chunk.path || '').trim();
    const matchesSection = selectedSectionIds.has(chunk.pageId) || selectedSectionIds.has(chunk.sectionId);
    const matchesPath = selectedPaths.some(path => chunkPath === path || chunkPath.startsWith(`${path} /`));
    if (!matchesSection && !matchesPath) continue;
    const keyId = chunk.pageId || chunk.sectionId;
    const count = counts.get(keyId) || 0;
    if (count >= perSectionLimit) continue;
    counts.set(keyId, count + 1);
    balanced.push(chunk);
  }

  return balanced;
}

function dedupeChunks(chunks) {
  const seen = new Set();
  const unique = [];
  for (const chunk of Array.isArray(chunks) ? chunks : []) {
    if (!chunk) continue;
    const key = `${chunk.pageId}|${chunk.path}|${chunk.text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(chunk);
  }
  return unique;
}

function getCrossLanguageRetrievalTerms(language) {
  const selectedLanguage = normalizeLanguage(language);
  const base = {
    en: [
      'documents', 'required documents', 'price', 'cost', 'fee',
      'address', 'location', 'office', 'contacts',
      'deadline', 'deadlines', 'processing time',
      'conditions', 'requirements',
      'remote', 'online', 'without travel', 'without visit', 'no travel', 'no visit',
      'instruction', 'instructions', 'how to', 'what to do',
      'what to reply', 'what should we reply', 'reply to the client', 'ready-made reply'
    ],
    ru: [],
    ua: []
  };

  return base[selectedLanguage] || [];
}

function getSafeClientReply(language) {
  return {
    ua: 'Доброго дня! Зараз перевіримо інформацію по вашому запиту та одразу повернемося з відповіддю.',
    ru: 'Добрый день! Сейчас проверим информацию по вашему запросу и сразу вернёмся с ответом.',
    en: 'Hello! We will check the information for your request and get back to you shortly.'
  }[normalizeLanguage(language)] || 'Доброго дня! Зараз перевіримо інформацію по вашому запиту та повернемося з відповіддю.';
}

function augmentAnswerWithQualifierNote({ question, answer, sources, language, mode }) {
  if (mode === 'client_reply') return answer;
  const qualifier = extractAudienceQualifier(question);
  if (!qualifier) return answer;

  const normalizedQualifier = normalize(qualifier);
  const sourceText = normalize(
    (Array.isArray(sources) ? sources : [])
      .map(item => `${item.title || ''} ${item.path || ''} ${item.snippet || ''} ${item.text || ''}`)
      .join(' ')
  );

  if (sourceText.includes(normalizedQualifier)) return answer;

  const note = {
    ua: `У базі знань немає окремого правила для клієнтів ${qualifier}.`,
    ru: `В базе знаний нет отдельного правила для клиентов ${qualifier}.`,
    en: `The knowledge base does not state a separate rule for ${qualifier} clients.`
  }[normalizeLanguage(language)] || `The knowledge base does not state a separate rule for ${qualifier} clients.`;

  return `${note} ${answer}`.trim();
}

function extractAudienceQualifier(question) {
  const text = String(question || '');
  const match = text.match(/\b(?:for|for the|для)\s+([a-zа-яёіїєґ'][a-zа-яёіїєґ'\-]{2,})\s+(?:clients?|client|customers?|customers|клиент[а-яёіїєґ]*|клієнт[а-яёіїєґ]*)/i);
  return match?.[1] || '';
}

function buildContextChunks(chunks, maxChunks = 36, maxChars = 36000) {
  const selected = [];
  const pageCounts = new Map();
  let chars = 0;

  for (const chunk of chunks) {
    if (!chunk) continue;
    const snippet = String(chunk.text || '').replace(/\s+/g, ' ').trim();
    if (!snippet) continue;

    const pageCount = pageCounts.get(chunk.pageId) || 0;
    if (pageCount >= 15) continue;

    const nextChars = chars + snippet.length;
    if (selected.length >= maxChunks || nextChars > maxChars) continue;

    selected.push({ ...chunk, text: snippet });
    pageCounts.set(chunk.pageId, pageCount + 1);
    chars = nextChars;
  }

  return selected;
}

function buildGroundedAnswer(chunks) {
  const uniqueChunks = dedupeSources(chunks)
    .filter(chunk => {
      const snippet = makeSnippet(chunk.text, 260);
      if (!snippet) return false;
      if (snippet.length < 25) return false;
      if (/^name:/i.test(snippet)) return false;
      if (/^С†РµР»СЊ$/i.test(snippet)) return false;
      return true;
    })
    .slice(0, 2);
  if (!uniqueChunks.length) return '';
  return uniqueChunks
    .map(chunk => makeSnippet(chunk.text, 260))
    .filter(Boolean)
    .join(' ');
}

function scoreTextOverlap(text, tokens) {
  const haystack = normalize(text);
  if (!haystack || !tokens.length) return 0;
  let score = 0;
  for (const token of tokens) {
    if (haystack.includes(token)) score += token.length >= 6 ? 3 : 1;
  }
  return score;
}

function tokenize(value) {
  const stopWords = new Set([
    'and', 'the', 'for', 'with', 'that', 'this', 'from', 'what', 'when', 'where',
    'как', 'что', 'это', 'или', 'для', 'если', 'при', 'you', 'your', 'та', 'це', 'для', 'якщо', 'при', 'або', 'під', 'над'
  ]);
  const baseTokens = normalize(value)
    .split(/[^a-zа-яёіїєґ0-9]+/i)
    .map(token => stemToken(token.trim()))
    .filter(token => token.length > 2 && !stopWords.has(token));

  const expanded = [];
  for (const token of baseTokens) {
    expanded.push(token);
    if (token === 'code' || token === 'код') {
      expanded.push(token === 'code' ? 'код' : 'code');
    } else if (token === 'chip' || token === 'чип' || token === 'чіп') {
      expanded.push(...['chip', 'чип', 'чіп'].filter(t => t !== token));
    } else if (token === 'card' || token === 'карт' || token === 'картк') {
      expanded.push(...['card', 'карт', 'картк'].filter(t => t !== token));
    }
  }
  return expanded;
}

function normalize(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeIntentText(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function stemToken(value) {
  let token = normalize(value);
  if (!token) return '';

  const reflexive = ['ся', 'сь'];
  const verbEndings = [
    'уть', 'ють', 'ить', 'ять', 'ешь', 'ет', 'ем', 'ете', 'ут', 'ют',
    'ишь', 'ит', 'им', 'ите', 'ат', 'ят', 'емо', 'имо', 'ть', 'ти',
    'вши', 'в', 'ла', 'ло', 'ли', 'л', 'мо'
  ];
  const adjectiveEndings = [
    'ными', 'ними', 'ому', 'ему', 'ыми', 'ими', 'ое', 'ее', 'ая', 'яя',
    'ые', 'ие', 'ый', 'ий', 'ій', 'ой', 'ей', 'ым', 'им', 'ім', 'ов',
    'ев', 'ів', 'ую', 'юю', 'ых', 'их', 'ах', 'ях'
  ];
  const nounEndings = [
    'иями', 'ям', 'ами', 'ого', 'ему', 'ому', 'ими', 'ыми',
    'ом', 'ем', 'ам', 'ям', 'ах', 'ях', 'ов', 'ев', 'ей', 'ий',
    'ою', 'ею', 'а', 'я', 'ы', 'и', 'і', 'и', 'у', 'ю', 'е', 'о', 'ь'
  ];

  const strip = (word, suffixes) => {
    for (const suffix of suffixes) {
      if (word.length - suffix.length > 3 && word.endsWith(suffix)) {
        return word.slice(0, -suffix.length);
      }
    }
    return word;
  };

  let prev;
  do {
    prev = token;
    token = strip(token, reflexive);
    token = strip(token, adjectiveEndings);
    token = strip(token, verbEndings);
    token = strip(token, nounEndings);
  } while (token !== prev);

  return token;
}

function makeSnippet(text, limit = 380) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (clean.length <= limit) return clean;
  return `${clean.slice(0, limit - 1)}вЂ¦`;
}

async function getSourceInfo() {
  if (notionSourceType === 'page') {
    const rootPage = await notion.pages.retrieve({ page_id: notionRootPageId });
    const title = getPageTitle(rootPage) || 'Notion root';
    return {
      title,
      path: title
    };
  }

  if (notionSourceType === 'database') {
    const database = await notion.databases.retrieve({ database_id: notionDatabaseId });
    const title = getDatabaseTitle(database) || 'Notion database';
    return {
      title,
      path: title
    };
  }

  return {
    title: '',
    path: ''
  };
}

function getDatabaseTitle(database) {
  const title = database?.title;
  if (Array.isArray(title)) {
    const value = richTextToPlain(title);
    if (value) return value;
  }
  return '';
}

function getMissingEnvKeys() {
  const missing = [];
  if (!notionToken) missing.push('NOTION_TOKEN');
  if (!notionRootPageId && !notionDatabaseId) missing.push('NOTION_ROOT_PAGE_ID|NOTION_DATABASE_ID');
  if (!process.env.GEMINI_API_KEY) missing.push('GEMINI_API_KEY');
  if (AI_PROVIDER !== 'gemini') missing.push('AI_PROVIDER=gemini');
  return missing;
}

async function generateGeminiAnswer({ question, context, language, fallback }) {
  const selectedLanguage = normalizeLanguage(language);
  const localizedFallback = fallback || getFallbackAnswer(selectedLanguage);
  const languageInstruction = {
    ua: 'Відповідай лише українською мовою.',
    ru: 'Отвечай только на русском языке.',
    en: 'Answer only in English.'
  }[selectedLanguage];
  const systemInstruction = [
    'You are an internal knowledge-base assistant for managers.',
    languageInstruction,
    'Answer only from the provided CONTEXT.',
    'Do not use outside knowledge, memory, or general facts.',
    'If the question has multiple parts, answer each part separately and cover every part that is supported by the CONTEXT.',
    'If the CONTEXT contains relevant procedures, rules, instructions, documents, prices, terms, or conditions that help answer the question, synthesize a concise answer from them.',
    `If the CONTEXT does not contain enough relevant information to answer safely, reply with exactly: ${localizedFallback}`,
    'Do not mention policy, limitations, or that you are an AI.',
    'Keep the answer concise, factual, and grounded in the context.',
    'If multiple relevant fragments are found, first determine which of them belongs specifically to the scenario the user is asking about.',
    'Do not consider information contradictory simply because different options of a process exist. Different documents may describe different scenarios of the same service.',
    'If the question relates to a specific scenario (e.g., remote registration, in-office registration, a specific category of client, etc.), use the context of that specific scenario.',
    'Report contradictions only when multiple sources describe the exact same scenario but provide incompatible information.',
    'If the answer is only partially found, answer based on the found information and separately indicate which data is missing. Do not trigger the fallback message if any relevant context has already been found.',
    'Do not merge different scenarios into a single answer and do not draw conclusions that are not present in the provided context.',
    'Do not change the response language. Answer in the same language as the user\'s question.'
  ].join(' ');

  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  const model = genAI.getGenerativeModel({
    model: GEMINI_MODEL,
    systemInstruction
  });

  const result = await model.generateContent({
    contents: [
      {
        role: 'user',
        parts: [
          {
            text: `QUESTION:\n${question}\n\nCONTEXT:\n${context}`
          }
        ]
      }
    ],
    generationConfig: {
      temperature: 0,
      topP: 1,
      maxOutputTokens: 1600
    }
  });

  return result.response.text();
}

async function generateGeminiAnswerV2({ question, context, language, fallback, mode = 'fact' }) {
  const selectedLanguage = normalizeLanguage(language);
  const localizedFallback = fallback || getFallbackAnswer(selectedLanguage);
  const languageInstruction = {
    ua: 'Answer in Ukrainian.',
    ru: 'Answer in Russian.',
    en: 'Answer in English.'
  }[selectedLanguage];
  const modeInstruction = mode === 'client_reply'
    ? 'The user wants a ready-to-send message for another person. Return only the client-facing reply, not internal notes or explanations. If some status is missing in CONTEXT, do not invent it; write a safe neutral reply that asks to verify the status or promises a follow-up.'
    : 'The user wants an internal knowledge-base answer for a manager. Keep it practical, complete, and readable.';
  const systemInstruction = [
    'You are an internal knowledge-base assistant for managers.',
    languageInstruction,
    modeInstruction,
    'Answer only from the provided CONTEXT.',
    'Do not use outside knowledge, memory, guesses, or general facts.',
    'Before answering, internally split the user question into separate semantic parts and verify that each part is answered.',
    'Read the entire CONTEXT first, then synthesize the answer across all relevant pages, subpages, child databases, and message templates.',
    'Do not stop at the first relevant chunk.',
    'Use the full context, not just the first or strongest snippet.',
    'Do not treat semantically related but different pages as the answer. A source is relevant only if it directly answers the requested part.',
    'If multiple sources support one part of the answer, combine them into one coherent response.',
    'If the question includes documents, price, deadlines, address, contacts, conditions, steps, or message templates, answer each of those parts separately.',
    'If the context contains a list of documents, return the complete merged list of documents from all relevant sources; do not compress it to one example or a subset.',
    'If the context contains a price, state it clearly in its own section, even when the price appears in a different source than the documents.',
    'If one part of the question is answered by the CONTEXT and another part is not, answer the found part and explicitly write: "Информация по этому пункту отсутствует в базе знаний." for the missing part.',
    'If the question asks what to reply to a client, employee, or another person, return a ready-to-send message in natural language, not internal analysis.',
    'For client replies, keep the tone practical, polite, and safe; if the status is not explicitly confirmed in CONTEXT, do not invent it.',
    'Never claim a document, status, price, or deadline unless the CONTEXT explicitly supports it.',
    'Do not copy chunks verbatim. Rephrase the information in clear human language.',
    'Do not omit any supported part of the question.',
    'If the answer language is English but the CONTEXT is in Russian or Ukrainian, translate the full answer into English without dropping any supported facts.',
    'If the answer has several parts, you must structure it with separate labeled sections such as: Documents:, Price:, Deadlines:, Address:, Conditions:, Suggested reply:.',
    'Do not merge documents, price, deadlines, and conditions into one paragraph when the question asks for more than one of them.',
    'If a labeled section is missing from CONTEXT, keep the label and write the missing-information phrase instead of omitting the section.',
    'If the context contains a price anywhere relevant, include it together with the answer even if it comes from a different source than the documents.',
    'If the context contains an address, contact, or operating location, include it clearly and separately.',
    'If the context does not contain enough information to answer a part precisely, say so explicitly and do not fill the gap with assumptions.',
    'Do not write unfinished phrases, ellipses, "etc.", "С‚РѕС‰Рѕ", or "etc." without specifics.',
    'Do not mention that you are an AI or refer to policies or limitations.',
    'Keep the answer complete, grounded, and useful for a manager.',
    `If the CONTEXT is insufficient for a safe answer overall, reply with exactly this text and nothing else: ${localizedFallback}`,
    'Avoid markdown tables.',
    'Prefer short paragraphs or bullet lists when the answer has multiple parts.',
    'If multiple relevant fragments are found, first determine which of them belongs specifically to the scenario the user is asking about.',
    'Do not consider information contradictory simply because different options of a process exist. Different documents may describe different scenarios of the same service.',
    'If the question relates to a specific scenario (e.g., remote registration, in-office registration, a specific category of client, etc.), use the context of that specific scenario.',
    'Report contradictions only when multiple sources describe the exact same scenario but provide incompatible information.',
    'If the answer is only partially found, answer based on the found information and separately indicate which data is missing. Do not trigger the fallback message if any relevant context has already been found.',
    'Do not merge different scenarios into a single answer and do not draw conclusions that are not present in the provided context.',
    'Do not change the response language. Answer in the same language as the user\'s question.',
    'Before finalizing, do a silent self-check that every question part has been addressed and that no unsupported claim was added.'
  ].join(' ');

  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  const model = genAI.getGenerativeModel({
    model: GEMINI_MODEL,
    systemInstruction
  });

  const result = await model.generateContent({
    contents: [
      {
        role: 'user',
        parts: [
          {
            text: `QUESTION:\n${question}\n\nCONTEXT:\n${context}`
          }
        ]
      }
    ],
    generationConfig: {
      temperature: 0,
      topP: 1,
      maxOutputTokens: 3000
    }
  });

  return sanitizeGeminiAnswer(result.response.text());
}

function sanitizeGeminiAnswer(answer) {
  return String(answer || '')
    .replace(/\u2026/g, '.')
    .replace(/\.{3,}/g, '.')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function normalizeLanguage(value) {
  const language = String(value || '').trim().toLowerCase();
  if (language === 'ua' || language === 'uk') return 'ua';
  if (language === 'ru' || language === 'en') return language;
  return DEFAULT_LANGUAGE;
}

function getFallbackAnswer(language) {
  return FALLBACK_ANSWERS[normalizeLanguage(language)] || FALLBACK_ANSWERS[DEFAULT_LANGUAGE];
}

main().catch(error => {
  const details = formatErrorDetails(error);
  console.error(details.stack || details.message || details);
  process.exitCode = 1;
});

function formatErrorDetails(error) {
  const details = {
    name: error?.name || 'Error',
    message: error?.message || String(error || ''),
    stack: error?.stack || '',
    code: error?.code || error?.errorCode || null,
    type: error?.type || null,
    errno: error?.errno || null,
    syscall: error?.syscall || null,
    address: error?.address || null,
    port: error?.port || null,
    status: error?.status || error?.statusCode || error?.response?.status || null,
    statusText: error?.statusText || error?.response?.statusText || null,
    body: null,
    cause: serializeErrorCause(error?.cause || null)
  };

  const body = error?.body || error?.response?.body || error?.response?.data || null;
  if (body !== null && body !== undefined) {
    if (typeof body === 'string') {
      details.body = body;
    } else {
      try {
        details.body = JSON.stringify(body);
      } catch (_err) {
        details.body = String(body);
      }
    }
  }

  return details;
}

function serializeErrorCause(cause, depth = 0) {
  if (!cause || depth > 2) return null;
  return {
    name: cause?.name || null,
    message: cause?.message || null,
    code: cause?.code || null,
    errno: cause?.errno || null,
    syscall: cause?.syscall || null,
    address: cause?.address || null,
    port: cause?.port || null,
    type: cause?.type || null,
    stack: cause?.stack || null,
    cause: serializeErrorCause(cause?.cause || null, depth + 1)
  };
}

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`${label} timed out after ${ms}ms`);
      err.code = 'ETIMEDOUT';
      reject(err);
    }, ms);
  });
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    timeout
  ]);
}

function detectRetrievalIntents(question, language, mode = 'fact') {
  if (mode === 'client_reply') return ['client_reply'];
  const text = normalizeIntentText(`${question || ''} ${language || ''}`);
  const intents = [];
  const patterns = [
    ['client_reply', /(\bчто ответить\b|\bкак ответить\b|\bщо відповісти\b|\bяк відповісти\b|\bответить клиенту\b|\bвідповісти клієнту\b|\bклиент написал\b|\bклієнт написав\b|\bthe customer wrote\b|\bcustomer wrote\b|\bclient wrote\b|\bhow should i respond\b|\bhow should we reply\b|\bwhat should i reply\b|\bwhat should we reply\b|\bwhat to reply\b|\bhow to reply\b|\breply to the client\b|\breply to the customer\b|\bsend to the client\b)/i],
    ['payment', /(\bpayment\b|\bоплата\b|\bоплаты\b|\binvoice\b|\bbank account\b|\bbank transfer\b|\bwire transfer\b|\bсчет\b|\bсчёт\b|\bрахунок\b|\baccount number\b|\bpayment details\b|\bpayment reference\b)/i],
    ['remote', /(\bremote\b|\bonline\b|\bwithout travel\b|\bwithout visit\b|\bno travel\b|\bno visit\b|\bудаленно\b|\bвіддалено\b|\bдистанц\b|\bдистанційно\b|\bбез приезда\b|\bбез візиту\b)/i],
    ['documents', /(\bdocument\b|\bdocuments\b|\bdoc\b|\bdocs\b|\bдокумент\b|\bдокументы\b|\bдокументи\b|\bнеобходимые documents\b|\bнеобходимые документы\b|\bнеобхідні документи\b)/i],
    ['price', /(\bprice\b|\bcost\b|\bfee\b|\bцена\b|\bстоимость\b|\bвартість\b|\bсколько стоит\b|\bhow much\b|\bhow much does it cost\b)/i],
    ['address', /(\baddress\b|\blocation\b|\boffice\b|\bадрес\b|\bофис\b|\bадреса\b|\bлокация\b|\bмісце\b)/i],
    ['deadlines', /(\bdeadline\b|\bdeadlines\b|\bterm\b|\bterms\b|\bprocessing time\b|\bсрок\b|\bсроки\b|\bтермін\b|\bтерміни\b|\bдедлайн\b)/i],
    ['conditions', /(\bconditions\b|\brequirements\b|\bусловия\b|\bумови\b|\brequired\b|\bmust\b|\bneed\b|\bif\b|\bwhen\b)/i],
    ['instruction', /(\binstruction\b|\binstructions\b|\bhow to\b|\bwhat to do\b|\bstep by step\b|\bинструкция\b|\bінструкція\b|\bкак сделать\b|\bщо робити\b)/i]
  ];

  for (const [intent, pattern] of patterns) {
    if (pattern.test(text)) intents.push(intent);
  }

  return intents.length ? intents : ['general'];
}

function getIntentTerms(language) {
  const selectedLanguage = normalizeLanguage(language);
  const base = {
    client_reply: ['что ответить', 'как ответить', 'що відповісти', 'як відповісти', 'ответить клиенту', 'відповісти клієнту', 'клиент написал', 'клієнт написав', 'the customer wrote', 'customer wrote', 'client wrote', 'how should i respond', 'what should i reply', 'how to reply', 'what should we reply', 'what to reply', 'how should we reply', 'reply to the customer', 'reply to the client', 'send to the client', 'ready-made reply', 'message template', 'template', 'message', 'communication', 'communications', 'follow-up', 'after call', 'after the call', 'після дзвінка', 'шаблон сообщения', 'шаблон', 'повідомлення', 'комунікація', 'коммуникация'],
    payment: ['payment', 'оплата', 'оплаты', 'invoice', 'bank account', 'bank transfer', 'wire transfer', 'счет', 'счёт', 'рахунок', 'account', 'account number', 'bill', 'proforma invoice', 'payment details', 'payment reference'],
    remote: ['remote', 'online', 'without travel', 'without visit', 'no travel', 'no visit', 'удаленно', 'віддалено', 'дистанц', 'дистанційно', 'без приезда', 'без візиту'],
    documents: ['document', 'documents', 'doc', 'docs', 'документ', 'документы', 'документи', 'потрібні документи', 'необхідні документи'],
    price: ['price', 'cost', 'fee', 'цena', 'цена', 'стоимость', 'вартість', 'сколько стоит', 'how much', 'how much does it cost'],
    address: ['address', 'location', 'office', 'адрес', 'офис', 'адреса', 'локація', 'місце', 'контакт', 'contacts'],
    deadlines: ['deadline', 'deadlines', 'term', 'terms', 'processing time', 'срок', 'сроки', 'термін', 'терміни', 'дедлайн'],
    conditions: ['conditions', 'requirements', 'условия', 'умови', 'required', 'must', 'need', 'if', 'when'],
    instruction: ['instruction', 'instructions', 'how to', 'what to do', 'step by step', 'инструкция', 'інструкція', 'как сделать', 'що робити'],
    general: []
  };

  if (selectedLanguage === 'ru') {
    return {
      ...base,
      documents: [...base.documents, 'список документов', 'необходимые документы'],
      price: [...base.price, 'цены', 'прайс'],
      payment: [...base.payment, 'реквизиты', 'счет для оплаты'],
      address: [...base.address, 'где находится'],
      deadlines: [...base.deadlines, 'когда будет готово'],
      conditions: [...base.conditions, 'требования'],
      instruction: [...base.instruction, 'что делать']
    };
  }

  if (selectedLanguage === 'ua') {
    return {
      ...base,
      documents: [...base.documents, 'список документів', 'необхідні документи'],
      price: [...base.price, 'ціна', 'вартість'],
      payment: [...base.payment, 'реквізити', 'рахунок для оплати'],
      address: [...base.address, 'де знаходиться'],
      deadlines: [...base.deadlines, 'коли буде готово'],
      conditions: [...base.conditions, 'вимоги'],
      instruction: [...base.instruction, 'що робити']
    };
  }

  return base;
}

function getRetrievalTopics(language) {
  const intentTerms = getIntentTerms(language);
  return [
    { key: 'client_reply', terms: intentTerms.client_reply },
    { key: 'documents', terms: intentTerms.documents },
    { key: 'price', terms: intentTerms.price },
    { key: 'payment', terms: intentTerms.payment },
    { key: 'address', terms: intentTerms.address },
    { key: 'deadlines', terms: intentTerms.deadlines },
    { key: 'conditions', terms: intentTerms.conditions },
    { key: 'remote', terms: intentTerms.remote },
    { key: 'instruction', terms: intentTerms.instruction }
  ];
}

const INTERNAL_RETRIEVAL_TERMS = [
  'crm', 'keycrm', 'bot', 'helper bot', 'guide', 'invoice', 'invoices',
  'regulation', 'regulations', 'communications', 'communication', 'accounts',
  'account helper', 'payment instructions', 'payment details', 'payment workflow',
  'button', 'buttons', 'click', 'press', 'press button', 'select', 'choose',
  'what to click', 'what to press', 'how to click', 'how to press', 'how to choose',
  'internal', 'operational', 'workflow', 'template', 'templates',
  'requisites', 'реквизиты', 'реквізити', 'счет', 'счёт', 'рахунок', 'bill', 'billing',
  'bank details', 'bank account', 'bank transfer', 'wire transfer', 'iban', 'swift'
];

const STRONG_INTERNAL_RETRIEVAL_TERMS = [
  'crm', 'keycrm', 'bot', 'helper bot', 'guide', 'invoice', 'invoices',
  'regulation', 'regulations', 'communications', 'communication', 'accounts',
  'account helper', 'payment workflow'
];

const SERVICE_RETRIEVAL_TERMS = [
  'documents', 'document', 'price', 'cost', 'fee', 'conditions', 'requirements',
  'deadline', 'deadlines', 'processing time', 'address', 'location', 'office',
  'remote', 'online', 'without travel', 'without visit', 'service', 'visa',
  'residence', 'certificate', 'qualification', 'course', 'driver', 'license',
  'message template', 'reply', 'client reply'
];

const OPERATIONAL_QUERY_TERMS = [
  'invoice', 'invoices', 'payment', 'payments', 'bank account', 'bank transfer',
  'wire transfer', 'account number', 'account for payment', 'requisites',
  'реквизиты', 'реквізити', 'счет', 'счёт', 'рахунок', 'crm', 'bot',
  'keycrm', 'helper bot', 'what to click', 'what button', 'what to press',
  'how to click', 'how to press', 'button', 'buttons', 'click', 'press',
  'payment details', 'payment reference'
];

function countKeywordHits(text, terms) {
  const haystack = normalize(text);
  let hits = 0;
  for (const term of Array.isArray(terms) ? terms : []) {
    const normalizedTerm = normalize(term);
    if (normalizedTerm && haystack.includes(normalizedTerm)) {
      hits += 1;
    }
  }
  return hits;
}

function getRetrievalPageProfile(text) {
  const haystack = normalize(text);
  const strongInternalHits = countKeywordHits(haystack, STRONG_INTERNAL_RETRIEVAL_TERMS);
  const internalHits = countKeywordHits(haystack, INTERNAL_RETRIEVAL_TERMS);
  const serviceHits = countKeywordHits(haystack, SERVICE_RETRIEVAL_TERMS);

  let kind = 'neutral';
  if (strongInternalHits > 0 && serviceHits <= strongInternalHits) {
    kind = 'internal';
  } else if (internalHits >= 2 && internalHits > serviceHits) {
    kind = 'internal';
  } else if (serviceHits >= 2 && serviceHits > internalHits) {
    kind = 'service';
  }

  return { kind, internalHits: internalHits + strongInternalHits, serviceHits, strongInternalHits };
}

function queryAllowsOperationalPages(question) {
  const text = normalize(question);
  if (!text) return false;
  if (detectRetrievalIntents(question).includes('client_reply')) return true;
  return OPERATIONAL_QUERY_TERMS.some(term => text.includes(normalize(term)));
}

function getRetrievalPageBias(kind, allowOperationalPages) {
  if (kind === 'internal') {
    return allowOperationalPages ? 10 : -80;
  }
  if (kind === 'service') {
    return allowOperationalPages ? 4 : 18;
  }
  return allowOperationalPages ? 1 : 3;
}



