const ENABLED_KEY = 'gev.elevenlabs.enabled';
const VOICE_KEY = 'gev.elevenlabs.voice';
const SENTENCE_END = /([.!?]+["')\]]*)(\s+|$)/;
const MAX_CHUNK_CHARS = 400;

function readStorage(storage, key) {
  try {
    return storage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function writeStorage(storage, key, value) {
  try {
    storage?.setItem(key, value);
  } catch {
    /* storage unavailable: the choice lasts for this page only */
  }
}

/**
 * Split streamed text into speakable sentences. Returns the sentences that are
 * complete and the unfinished remainder. A long run without punctuation is cut
 * at a space so no chunk exceeds the proxy's limit.
 */
export function splitSpeakable(buffer) {
  const sentences = [];
  let rest = buffer;
  for (;;) {
    const match = SENTENCE_END.exec(rest);
    if (!match || (match.index + match[1].length === rest.length && !match[2]))
      break;
    const end = match.index + match[0].length;
    const sentence = rest.slice(0, end).trim();
    if (sentence) sentences.push(sentence);
    rest = rest.slice(end);
  }
  while (rest.length > MAX_CHUNK_CHARS) {
    const cut = rest.lastIndexOf(' ', MAX_CHUNK_CHARS);
    const at = cut > 0 ? cut : MAX_CHUNK_CHARS;
    sentences.push(rest.slice(0, at).trim());
    rest = rest.slice(at);
  }
  return { sentences, rest };
}

/**
 * Speaks the assistant's replies through ElevenLabs. OpenAI Realtime still
 * listens, thinks and calls tools; this only turns its transcript into speech.
 * The browser never sees the API key: audio comes from /api/elevenlabs/tts.
 */
export function createElevenLabsVoice({
  fetchImpl = (...args) => fetch(...args),
  storage = globalThis.localStorage,
  createAudio = (url) => new Audio(url),
  urlApi = URL,
  debugLog = () => {},
} = {}) {
  let available = false;
  let defaultVoiceId = null;
  let generation = 0;
  let playing = null;
  let draining = false;
  const queue = [];
  const buffers = new Map();
  const spoken = new Set();
  const live = new Set();
  // Responses cut off by stop(): their late deltas and done event stay silent.
  const suppressed = new Set();

  const isEnabled = () =>
    available && readStorage(storage, ENABLED_KEY) !== '0';
  const getVoiceId = () => readStorage(storage, VOICE_KEY) || defaultVoiceId;

  async function init() {
    try {
      const response = await fetchImpl('/api/elevenlabs/status', {
        cache: 'no-store',
      });
      const data = response.ok ? await response.json() : null;
      available = Boolean(data?.available);
      defaultVoiceId = data?.defaultVoiceId || null;
    } catch {
      available = false;
    }
    return available;
  }

  async function listVoices() {
    const response = await fetchImpl('/api/elevenlabs/voices', {
      cache: 'no-store',
    });
    if (!response.ok) throw new Error(`Voices failed: HTTP ${response.status}`);
    const data = await response.json();
    return Array.isArray(data?.voices) ? data.voices : [];
  }

  function fetchAudio(text, mine) {
    const controller = new AbortController();
    const item = { controller, blobUrl: null, failed: false };
    item.ready = fetchImpl('/api/elevenlabs/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, voiceId: getVoiceId() }),
      signal: controller.signal,
      cache: 'no-store',
    })
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const blob = await response.blob();
        if (mine !== generation) return;
        item.blobUrl = urlApi.createObjectURL(blob);
      })
      .catch((error) => {
        item.failed = true;
        if (mine === generation)
          debugLog('elevenlabs.tts.failed', { error: error?.message });
      });
    return item;
  }

  function release(item) {
    item.controller.abort();
    if (item.blobUrl) {
      urlApi.revokeObjectURL(item.blobUrl);
      item.blobUrl = null;
    }
  }

  async function drain() {
    if (draining) return;
    draining = true;
    const mine = generation;
    try {
      while (queue.length && mine === generation) {
        const item = queue.shift();
        await item.ready;
        if (mine !== generation || item.failed || !item.blobUrl) {
          release(item);
          continue;
        }
        await new Promise((resolve) => {
          const audio = createAudio(item.blobUrl);
          playing = { audio, resolve };
          const done = () => {
            if (playing?.audio === audio) playing = null;
            release(item);
            resolve();
          };
          audio.addEventListener('ended', done, { once: true });
          audio.addEventListener('error', done, { once: true });
          Promise.resolve(audio.play()).catch(done);
        });
      }
    } finally {
      draining = false;
      if (queue.length && mine === generation) drain();
    }
  }

  function enqueue(text) {
    const clean = text.trim();
    if (!clean) return;
    queue.push(fetchAudio(clean, generation));
    drain();
  }

  /** Silence everything now: playing audio, queued chunks and half-built sentences. */
  function stop() {
    generation++;
    for (const id of live) suppressed.add(id);
    while (suppressed.size > 32)
      suppressed.delete(suppressed.values().next().value);
    live.clear();
    buffers.clear();
    spoken.clear();
    for (const item of queue.splice(0)) release(item);
    if (playing) {
      const { audio, resolve } = playing;
      playing = null;
      try {
        audio.pause();
      } catch {
        /* already stopped */
      }
      resolve();
    }
  }

  function feed(responseId, delta) {
    const key = responseId || '_';
    if (suppressed.has(key)) return;
    live.add(key);
    const { sentences, rest } = splitSpeakable(
      (buffers.get(key) || '') + delta,
    );
    buffers.set(key, rest);
    if (sentences.length) spoken.add(key);
    sentences.forEach(enqueue);
  }

  function finish(responseId, transcript) {
    const key = responseId || '_';
    live.delete(key);
    if (suppressed.delete(key)) {
      buffers.delete(key);
      return;
    }
    const rest = buffers.get(key) || '';
    buffers.delete(key);
    // A response that never streamed deltas still carries its full transcript.
    const text = rest || (spoken.has(key) ? '' : transcript || '');
    spoken.delete(key);
    const { sentences, rest: tail } = splitSpeakable(`${text} `);
    [...sentences, tail].forEach(enqueue);
  }

  /** Feed one Realtime server event. Ignored entirely when ElevenLabs is off. */
  function observe(event) {
    if (!isEnabled() || !event || typeof event.type !== 'string') return;
    const responseId = event.response_id || event.response?.id || null;
    switch (event.type) {
      case 'response.output_audio_transcript.delta':
        if (typeof event.delta === 'string') feed(responseId, event.delta);
        break;
      case 'response.output_audio_transcript.done':
        finish(responseId, event.transcript);
        break;
      case 'input_audio_buffer.speech_started':
      case 'output_audio_buffer.cleared':
        stop();
        break;
      case 'response.done':
        if (event.response?.status === 'cancelled') {
          buffers.delete(responseId || '_');
          spoken.delete(responseId || '_');
        }
        break;
      default:
    }
  }

  return {
    init,
    listVoices,
    observe,
    stop,
    get available() {
      return available;
    },
    get enabled() {
      return isEnabled();
    },
    get voiceId() {
      return getVoiceId();
    },
    setEnabled(on) {
      writeStorage(storage, ENABLED_KEY, on ? '1' : '0');
      if (!on) stop();
    },
    setVoiceId(id) {
      writeStorage(storage, VOICE_KEY, String(id));
    },
  };
}

/** The one shared instance the voice session and its settings control use. */
export const elevenLabsVoice = createElevenLabsVoice();
