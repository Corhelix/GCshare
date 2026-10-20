import { sameSiteGated } from './common/same-site.js';

const API_BASE = 'https://api.elevenlabs.io/v1';
// ElevenLabs premade voice (Sarah) available to every account; set
// ELEVENLABS_VOICE_ID in .env for your own.
const DEFAULT_VOICE_ID = 'EXAVITQu4vr4xnSDxMaL';
const DEFAULT_MODEL = 'eleven_flash_v2_5';
const OUTPUT_FORMAT = 'mp3_44100_64';
const MAX_TEXT_CHARS = 1000;
const MAX_BODY_BYTES = 8 * 1024;
const VOICE_ID_PATTERN = /^[A-Za-z0-9]{10,40}$/;
const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/** Read lazily: module evaluation happens before Vite's loadEnv() fills process.env. */
function readApiKey(environment = process.env) {
  return (
    environment.ELEVENLABS_API_KEY ||
    environment.ELEVEN_LABS_KEY ||
    ''
  ).trim();
}

function readDefaultVoiceId(environment = process.env) {
  const configured = String(environment.ELEVENLABS_VOICE_ID || '').trim();
  return VOICE_ID_PATTERN.test(configured) ? configured : DEFAULT_VOICE_ID;
}

function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

function isLoopback(req) {
  return LOOPBACK_ADDRESSES.has(String(req.socket?.remoteAddress || ''));
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

/**
 * GET /api/elevenlabs/status: whether a key is configured and the default
 * voice. Never returns the key.
 */
function createStatusHandler({ environment = process.env } = {}) {
  return (req, res) => {
    if (req.method !== 'GET')
      return sendJson(res, 405, { error: 'Method not allowed' });
    sendJson(res, 200, {
      available: Boolean(readApiKey(environment)) && isLoopback(req),
      defaultVoiceId: readDefaultVoiceId(environment),
    });
  };
}

/** GET /api/elevenlabs/voices: the voices on the configured account. */
function createVoicesHandler({
  environment = process.env,
  fetchImpl = (...args) => fetch(...args),
} = {}) {
  return async (req, res) => {
    if (req.method !== 'GET')
      return sendJson(res, 405, { error: 'Method not allowed' });
    const key = readApiKey(environment);
    if (!key) return sendJson(res, 503, { error: 'ElevenLabs key not set' });
    if (!isLoopback(req))
      return sendJson(res, 403, {
        error: 'ElevenLabs voice is available only from this machine',
      });
    try {
      const upstream = await fetchImpl(`${API_BASE}/voices`, {
        headers: { 'xi-api-key': key },
        redirect: 'error',
        signal: AbortSignal.timeout(15_000),
      });
      if (!upstream.ok)
        return sendJson(res, 502, {
          error: `ElevenLabs voices failed: HTTP ${upstream.status}`,
        });
      const data = await upstream.json();
      const voices = (Array.isArray(data?.voices) ? data.voices : [])
        .filter((voice) => VOICE_ID_PATTERN.test(String(voice?.voice_id)))
        .map((voice) => ({
          id: voice.voice_id,
          name: String(voice.name || voice.voice_id),
          category: voice.category || null,
        }));
      sendJson(res, 200, {
        voices,
        defaultVoiceId: readDefaultVoiceId(environment),
      });
    } catch {
      sendJson(res, 502, { error: 'ElevenLabs voices failed' });
    }
  };
}

/**
 * POST /api/elevenlabs/tts {text, voiceId?}: speaks one chunk of text and
 * streams the MP3 back. The key stays on the server.
 */
function createTtsHandler({
  environment = process.env,
  fetchImpl = (...args) => fetch(...args),
} = {}) {
  return async (req, res) => {
    if (req.method !== 'POST')
      return sendJson(res, 405, { error: 'Method not allowed' });
    const key = readApiKey(environment);
    if (!key) return sendJson(res, 503, { error: 'ElevenLabs key not set' });
    if (!isLoopback(req))
      return sendJson(res, 403, {
        error: 'ElevenLabs voice is available only from this machine',
      });
    let body;
    try {
      body = await readJsonBody(req);
    } catch (error) {
      return sendJson(res, 400, { error: error.message });
    }
    const text = String(body?.text || '').trim();
    if (!text) return sendJson(res, 400, { error: 'text is required' });
    if (text.length > MAX_TEXT_CHARS)
      return sendJson(res, 413, { error: 'text is too long' });
    const requested = String(body?.voiceId || '').trim();
    const voiceId = VOICE_ID_PATTERN.test(requested)
      ? requested
      : readDefaultVoiceId(environment);
    const model = environment.ELEVENLABS_MODEL || DEFAULT_MODEL;
    try {
      const upstream = await fetchImpl(
        `${API_BASE}/text-to-speech/${voiceId}/stream?output_format=${OUTPUT_FORMAT}`,
        {
          method: 'POST',
          redirect: 'error',
          signal: AbortSignal.timeout(30_000),
          headers: {
            'xi-api-key': key,
            'Content-Type': 'application/json',
            Accept: 'audio/mpeg',
          },
          body: JSON.stringify({ text, model_id: model }),
        },
      );
      if (!upstream.ok || !upstream.body) {
        console.warn(`[elevenlabs-tts] upstream HTTP ${upstream.status}`);
        return sendJson(res, 502, { error: 'ElevenLabs speech failed' });
      }
      res.statusCode = 200;
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Content-Type', 'audio/mpeg');
      const reader = upstream.body.getReader();
      res.on('close', () => reader.cancel().catch(() => {}));
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!res.write(value)) {
          await new Promise((resolve) => res.once('drain', resolve));
        }
      }
      res.end();
    } catch {
      console.warn('[elevenlabs-tts] request failed');
      if (!res.headersSent)
        sendJson(res, 502, { error: 'ElevenLabs speech failed' });
      else res.end();
    }
  };
}

/**
 * Vite plugin: ElevenLabs text-to-speech for the voice assistant. OpenAI keeps
 * listening and calling tools; this speaks its replies in the chosen voice.
 */
function elevenLabsProxy({ environment = process.env } = {}) {
  function install(middlewares) {
    middlewares.use(
      '/api/elevenlabs/status',
      sameSiteGated(createStatusHandler({ environment })),
    );
    middlewares.use(
      '/api/elevenlabs/voices',
      sameSiteGated(createVoicesHandler({ environment })),
    );
    middlewares.use(
      '/api/elevenlabs/tts',
      sameSiteGated(createTtsHandler({ environment })),
    );
  }
  return {
    name: 'elevenlabs-proxy',
    configureServer(server) {
      install(server.middlewares);
    },
    configurePreviewServer(server) {
      install(server.middlewares);
    },
  };
}

export {
  DEFAULT_VOICE_ID,
  createStatusHandler,
  createTtsHandler,
  createVoicesHandler,
  elevenLabsProxy,
  readApiKey,
};
