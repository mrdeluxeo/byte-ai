const fetch = require('node-fetch');
const { JSDOM } = require('jsdom');
const { Readability } = require('@mozilla/readability');
const cheerio = require('cheerio');

// OpenAI SDK compatibility helper
let OpenAIClientFactory = null;
try {
  const OpenAI = require('openai');
  if (OpenAI && typeof OpenAI.OpenAI === 'function') {
    OpenAIClientFactory = (apiKey) => new OpenAI.OpenAI({ apiKey });
  } else if (OpenAI && typeof OpenAI === 'function') {
    OpenAIClientFactory = (apiKey) => new OpenAI({ apiKey });
  } else if (OpenAI && OpenAI.Configuration && OpenAI.OpenAIApi) {
    const { Configuration, OpenAIApi } = OpenAI;
    OpenAIClientFactory = (apiKey) => new OpenAIApi(new Configuration({ apiKey }));
  }
} catch (e) {
  OpenAIClientFactory = null;
}

const OPENAI_KEY = process.env.OPENAI_API_KEY;
let openai = null;
if (OPENAI_KEY && OpenAIClientFactory) {
  try { openai = OpenAIClientFactory(OPENAI_KEY); } catch (e) { openai = null; }
}

let openaiMode = null;
if (openai) {
  if (openai.chat && openai.chat.completions && typeof openai.chat.completions.create === 'function') openaiMode = 'chat.completions.create';
  else if (typeof openai.createChatCompletion === 'function') openaiMode = 'createChatCompletion';
  else if (openai.responses && typeof openai.responses.create === 'function') openaiMode = 'responses.create';
}

async function callChatCompletion(messages, max_tokens = 500, model = 'gpt-4o-mini') {
  if (!openai) throw new Error('OpenAI client not configured');
  if (openaiMode === 'chat.completions.create') {
    const resp = await openai.chat.completions.create({ model, messages, max_tokens });
    if (resp && resp.choices && resp.choices[0]) return (resp.choices[0].message && resp.choices[0].message.content) || '';
    return '';
  }
  if (openaiMode === 'createChatCompletion') {
    const resp = await openai.createChatCompletion({ model, messages, max_tokens });
    return resp.data && resp.data.choices && resp.data.choices[0] && resp.data.choices[0].message ? resp.data.choices[0].message.content : '';
  }
  if (openaiMode === 'responses.create') {
    const joined = messages.map(m => (m.role ? m.role + ': ' : '') + (m.content || '')).join('\n');
    const resp = await openai.responses.create({ model, input: joined, max_tokens });
    if (resp && resp.output && resp.output.length) {
      const out = resp.output.find(o => o.content && o.content[0] && o.content[0].text);
      if (out) return out.content[0].text;
      if (typeof resp.output[0] === 'string') return resp.output[0];
    }
    return '';
  }
  throw new Error('OpenAI client does not support chat completion methods.');
}

function isGreeting(text) {
  if (!text) return false;
  const t = text.toLowerCase().trim();
  return /^(hi|hello|hey|yo|sup|howdy|good morning|good afternoon|good evening)\b/.test(t) || /\b(hi|hello|hey)\b/.test(t);
}

async function googleSearch(query) {
  const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
  let GOOGLE_CX = process.env.GOOGLE_CX;
  if (!GOOGLE_API_KEY || !GOOGLE_CX) throw new Error('Missing Google API credentials');
  if (GOOGLE_CX && GOOGLE_CX.includes('cx=')) {
    try { const u = new URL(GOOGLE_CX); const cx = u.searchParams.get('cx'); if (cx) GOOGLE_CX = cx; } catch (e) { const parts = GOOGLE_CX.split('cx='); if (parts[1]) GOOGLE_CX = parts[1].split('&')[0]; }
  }
  const params = new URLSearchParams({ key: GOOGLE_API_KEY, cx: GOOGLE_CX, q: query });
  const url = `https://www.googleapis.com/customsearch/v1?${params.toString()}`;
  const res = await fetch(url);
  if (!res.ok) {
    let bodyText = '';
    try { const body = await res.json(); bodyText = body.error && body.error.message ? body.error.message : JSON.stringify(body); } catch (e) { try { bodyText = await res.text(); } catch (e2) { bodyText = ''; } }
    throw new Error(`Google API error ${res.status}${bodyText ? ': ' + bodyText : ''}`);
  }
  return res.json();
}

async function fetchPageText(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (AI-search-bot)' } });
  if (!res.ok) throw new Error(`Fetch error ${res.status}`);
  const html = await res.text();
  try {
    const dom = new JSDOM(html, { url });
    const reader = new Readability(dom.window.document);
    const article = reader.parse();
    if (article && article.textContent) return article.textContent;
  } catch (e) {}
  const $ = cheerio.load(html);
  const bodyText = $('body').text().replace(/\s+/g, ' ').trim();
  return bodyText.substring(0, 20000);
}

async function synthesizeAnswer(question, sourceText, sourceUrl) {
  if (!openai) {
    const snippet = sourceText.replace(/\s+/g, ' ').trim().substring(0, 600);
    return `Paraphrased summary (from ${sourceUrl}):\n\n` + snippet + `\n\n(Note: set OPENAI_API_KEY for better rephrasing.)`;
  }
  const prompt = `You are a helpful assistant. Use the following source material to answer the question. Do not copy sentences verbatim from the source; rephrase the information in your own words. If the user included a greeting, greet them back warmly. If the source doesn't contain the answer, say so. Cite the source URL at the end.` + `\nSource:\n${sourceText}\n\nQuestion: ${question}\n\nAnswer concisely and in your own words:`;
  const text = await callChatCompletion([{ role: 'user', content: prompt }], 800, 'gpt-4o-mini');
  return `${text}\n\nSource: ${sourceUrl}`;
}

async function answerWithOpenAIOnly(question) {
  if (!openai) throw new Error('No OpenAI key available for fallback');
  const prompt = `You are a helpful assistant. Answer the question concisely in your own words. If the user included a greeting, greet them back warmly before answering. Avoid copying text verbatim from other sources.` + `\nQuestion: ${question}\n\nAnswer:`;
  const text = await callChatCompletion([{ role: 'user', content: prompt }], 500, 'gpt-4o-mini');
  return text;
}

exports.handler = async function(event, context) {
  try {
    if (!event.body) return { statusCode: 400, body: JSON.stringify({ error: 'Missing request body' }), headers: { 'Content-Type': 'application/json' } };
    const payload = JSON.parse(event.body);
    const question = payload.question;
    if (!question) return { statusCode: 400, body: JSON.stringify({ error: 'question required' }), headers: { 'Content-Type': 'application/json' } };

    // If Google not configured, try OpenAI-only fallback
    if (!process.env.GOOGLE_API_KEY || !process.env.GOOGLE_CX) {
      if (openai) {
        const text = await answerWithOpenAIOnly(question);
        return { statusCode: 200, body: JSON.stringify({ answer: text, source: null, title: null, note: 'answered using OpenAI (no Google search)' }), headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } };
      }
      return { statusCode: 400, body: JSON.stringify({ error: 'Missing Google API credentials. Set GOOGLE_API_KEY and GOOGLE_CX or provide OPENAI_API_KEY.' }), headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } };
    }

    const results = await googleSearch(question);
    const first = results.items && results.items[0];
    if (!first) return { statusCode: 404, body: JSON.stringify({ error: 'no results' }), headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } };

    const link = first.link;
    const text = await fetchPageText(link);
    const answer = await synthesizeAnswer(question, text, link);

    return { statusCode: 200, body: JSON.stringify({ answer, source: link, title: first.title }), headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } };
  } catch (err) {
    console.error('Function error:', err && (err.message || err));
    const body = { error: err && err.message ? err.message : String(err) };
    return { statusCode: 500, body: JSON.stringify(body), headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } };
  }
};
