const express = require('express');
const fetch = require('node-fetch');
const cors = require('cors');
const dotenv = require('dotenv');
const { JSDOM } = require('jsdom');
const { Readability } = require('@mozilla/readability');
const cheerio = require('cheerio');
const OpenAI = require('openai');

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
let GOOGLE_CX = process.env.GOOGLE_CX; // Search engine ID or CSE script URL

// Allow users to paste the full CSE script URL in .env (e.g. https://cse.google.com/cse.js?cx=XXXX)
if (GOOGLE_CX && GOOGLE_CX.includes('cx=')) {
  try {
    const u = new URL(GOOGLE_CX);
    const cx = u.searchParams.get('cx');
    if (cx) GOOGLE_CX = cx;
  } catch (e) {
    // fallback: try simple split
    const parts = GOOGLE_CX.split('cx=');
    if (parts[1]) GOOGLE_CX = parts[1].split('&')[0];
  }
}
const OPENAI_KEY = process.env.OPENAI_API_KEY;

let openai = null;
// Initialize OpenAI client robustly for different SDK shapes
if (OPENAI_KEY) {
  // Try v4 default export: new OpenAI({ apiKey })
  try {
    openai = new OpenAI({ apiKey: OPENAI_KEY });
    openai.isV4 = true;
  } catch (e) {
    // Try named export: OpenAI.OpenAI
    try {
      if (OpenAI && typeof OpenAI.OpenAI === 'function') {
        openai = new OpenAI.OpenAI({ apiKey: OPENAI_KEY });
        openai.isV4 = true;
      }
    } catch (e2) {
      // Try legacy SDK shape with Configuration/OpenAIApi
      try {
        const Configuration = OpenAI.Configuration;
        const OpenAIApi = OpenAI.OpenAIApi || OpenAI.OpenaiApi || OpenAI.OpenAIAPI;
        if (typeof Configuration === 'function' && typeof OpenAIApi === 'function') {
          const conf = new Configuration({ apiKey: OPENAI_KEY });
          openai = new OpenAIApi(conf);
          openai.isV4 = false;
        }
      } catch (e3) {
        // give up — openai stays null
        openai = null;
      }
    }
  }
}

async function callChatCompletion(messages, max_tokens = 500, model = 'gpt-4o-mini') {
  if (!openai) throw new Error('OpenAI client not configured');
  if (openai.isV4) {
    // new SDK: openai.chat.completions.create
    const resp = await openai.chat.completions.create({ model, messages, max_tokens });
    // prefer choices[0].message.content
    if (resp && resp.choices && resp.choices[0]) {
      return (resp.choices[0].message && resp.choices[0].message.content) || (resp.choices[0].delta && resp.choices[0].delta.content) || '';
    }
    return '';
  } else {
    const resp = await openai.createChatCompletion({ model, messages, max_tokens });
    return resp.data && resp.data.choices && resp.data.choices[0] && resp.data.choices[0].message ? resp.data.choices[0].message.content : '';
  }
}

function isGreeting(text) {
  if (!text) return false;
  const t = text.toLowerCase().trim();
  return /^(hi|hello|hey|yo|sup|howdy|good morning|good afternoon|good evening)\b/.test(t) || /\b(hi|hello|hey)\b/.test(t);
}

async function googleSearch(query) {
  if (!GOOGLE_API_KEY || !GOOGLE_CX) throw new Error('Missing Google API credentials');
  const params = new URLSearchParams({ key: GOOGLE_API_KEY, cx: GOOGLE_CX, q: query });
  const url = `https://www.googleapis.com/customsearch/v1?${params.toString()}`;
  const res = await fetch(url);
  if (!res.ok) {
    // try to parse JSON error body to show more context
    let bodyText = '';
    try {
      const body = await res.json();
      bodyText = body.error && body.error.message ? body.error.message : JSON.stringify(body);
    } catch (e) {
      try { bodyText = await res.text(); } catch (e2) { bodyText = ''; }
    }
    throw new Error(`Google API error ${res.status}${bodyText ? ': ' + bodyText : ''}`);
  }
  return res.json();
}

async function answerWithOpenAIOnly(question) {
  if (!openai) throw new Error('No OpenAI key available for fallback');
  const prompt = `You are a helpful assistant. Answer the question concisely in your own words. If the user included a greeting, greet them back warmly before answering. Avoid copying text verbatim from other sources.` +
    `\nQuestion: ${question}\n\nAnswer:`;
  const text = await callChatCompletion([{ role: 'user', content: prompt }], 500, 'gpt-4o-mini');
  return text;
}

async function fetchPageText(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (AI-search-bot)' } });
  if (!res.ok) throw new Error(`Fetch error ${res.status}`);
  const html = await res.text();

  // Try readability
  try {
    const dom = new JSDOM(html, { url });
    const reader = new Readability(dom.window.document);
    const article = reader.parse();
    if (article && article.textContent) return article.textContent;
  } catch (e) {
    // fallback
  }

  // fallback: grab main text via cheerio
  const $ = cheerio.load(html);
  const bodyText = $('body').text().replace(/\s+/g, ' ').trim();
  return bodyText.substring(0, 20000); // limit size
}

async function synthesizeAnswer(question, sourceText, sourceUrl) {
  // If OpenAI key provided, ask model to summarize / answer using source
  if (!openai) {
    // Without OpenAI we avoid returning large verbatim blocks. Provide a short paraphrased summary and suggest adding OPENAI_API_KEY for better rephrasing.
    const snippet = sourceText.replace(/\s+/g, ' ').trim().substring(0, 600);
    return `Paraphrased summary (from ${sourceUrl}):\n\n` + snippet + `\n\n(Note: for less verbatim, more fluent rephrasing, set OPENAI_API_KEY in your environment to enable OpenAI summarization.)`;
  }
  // Instruct the model to NOT copy verbatim from the source; rephrase and use the source to support the answer.
  const prompt = `You are a helpful assistant. Use the following source material to answer the question. Do not copy sentences verbatim from the source; rephrase the information in your own words. If the user included a greeting, greet them back warmly. If the source doesn't contain the answer, say so. Cite the source URL at the end.` +
    `\nSource:\n${sourceText}\n\nQuestion: ${question}\n\nAnswer concisely and in your own words:`;

  const text = await callChatCompletion([{ role: 'user', content: prompt }], 800, 'gpt-4o-mini');
  return `${text}\n\nSource: ${sourceUrl}`;
}

app.post('/api/answer', async (req, res) => {
  const { question } = req.body;
  if (!question) return res.status(400).json({ error: 'question required' });

  try {
    // If Google credentials are missing, try fallback to OpenAI only (no external source)
    if (!GOOGLE_API_KEY || !GOOGLE_CX) {
      if (openai) {
        const text = await answerWithOpenAIOnly(question);
        return res.json({ answer: text, source: null, title: null, note: 'answered using OpenAI (no Google search)' });
      }
      return res.status(400).json({ error: 'Missing Google API credentials. Set GOOGLE_API_KEY and GOOGLE_CX in your environment (or provide OPENAI_API_KEY for OpenAI-only fallback).' });
    }

    const results = await googleSearch(question);
    const first = results.items && results.items[0];
    if (!first) return res.status(404).json({ error: 'no results' });

    const link = first.link;
    const text = await fetchPageText(link);
    const answer = await synthesizeAnswer(question, text, link);

    res.json({ answer, source: link, title: first.title });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

const port = process.env.PORT || 3000;
const server = app.listen(port, () => console.log(`Server listening on ${port}`));

server.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE') {
    console.error(`Port ${port} is already in use. Try setting PORT to a different value or stop the process using that port.`);
    process.exit(1);
  }
  console.error('Server error:', err);
  process.exit(1);
});
