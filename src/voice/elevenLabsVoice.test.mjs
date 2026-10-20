import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createElevenLabsVoice, splitSpeakable } from './elevenLabsVoice.js';
import {
  createStatusHandler,
  createTtsHandler,
  createVoicesHandler,
} from '../../server/providers/elevenlabs.js';

function memoryStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => data.set(key, String(value)),
  };
}

function fakeAudioFactory(log) {
  return (url) => {
    const target = new EventTarget();
    const audio = {
      url,
      paused: false,
      addEventListener: (type, fn, opts) =>
        target.addEventListener(type, fn, opts),
      pause() {
        audio.paused = true;
      },
      play() {
        log.push(url);
        queueMicrotask(() => target.dispatchEvent(new Event('ended')));
        return Promise.resolve();
      },
    };
    return audio;
  };
}

function build({ storage = memoryStorage(), available = true } = {}) {
  const requests = [];
  const played = [];
  let counter = 0;
  const fetchImpl = async (url, init = {}) => {
    requests.push({ url, body: init.body ? JSON.parse(init.body) : null });
    if (url === '/api/elevenlabs/status')
      return Response.json({ available, defaultVoiceId: 'defaultvoice1' });
    return new Response(new Blob([`audio-${++counter}`]), { status: 200 });
  };
  const urlApi = {
    createObjectURL: () => `blob:${counter}-${requests.length}`,
    revokeObjectURL: () => {},
  };
  const voice = createElevenLabsVoice({
    fetchImpl,
    storage,
    urlApi,
    createAudio: fakeAudioFactory(played),
  });
  return { voice, requests, played, storage };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
const delta = (text, id = 'r1') => ({
  type: 'response.output_audio_transcript.delta',
  response_id: id,
  delta: text,
});

test('splitSpeakable only releases finished sentences and keeps the tail', () => {
  assert.deepEqual(splitSpeakable('Hello there. How are'), {
    sentences: ['Hello there.'],
    rest: 'How are',
  });
  assert.deepEqual(splitSpeakable('Wait for it.'), {
    sentences: [],
    rest: 'Wait for it.',
  });
  assert.deepEqual(splitSpeakable('It is 3.5 km away. Next'), {
    sentences: ['It is 3.5 km away.'],
    rest: 'Next',
  });
});

test('splitSpeakable cuts a long unpunctuated run below the proxy limit', () => {
  const { sentences, rest } = splitSpeakable('word '.repeat(300));
  assert.ok(sentences.length > 0);
  for (const sentence of sentences) assert.ok(sentence.length <= 400);
  assert.ok(rest.length <= 400);
});

test('speaks each finished sentence in the stored voice, in order', async () => {
  const { voice, requests, played } = build({
    storage: memoryStorage({ 'gev.elevenlabs.voice': 'chosenvoice99' }),
  });
  await voice.init();
  voice.observe(delta('Aircraft are overhead. '));
  voice.observe(delta('Three are military'));
  voice.observe({
    type: 'response.output_audio_transcript.done',
    response_id: 'r1',
    transcript: 'Aircraft are overhead. Three are military',
  });
  await settle();
  const tts = requests.filter((r) => r.url === '/api/elevenlabs/tts');
  assert.deepEqual(
    tts.map((r) => r.body.text),
    ['Aircraft are overhead.', 'Three are military'],
  );
  assert.ok(tts.every((r) => r.body.voiceId === 'chosenvoice99'));
  assert.equal(played.length, 2);
});

test('uses the server default voice until one is chosen', async () => {
  const { voice, requests } = build();
  await voice.init();
  voice.observe(delta('Hello. '));
  await settle();
  assert.equal(
    requests.find((r) => r.url === '/api/elevenlabs/tts').body.voiceId,
    'defaultvoice1',
  );
});

test('a transcript with no streamed deltas is still spoken from the done event', async () => {
  const { voice, requests } = build();
  await voice.init();
  voice.observe({
    type: 'response.output_audio_transcript.done',
    response_id: 'r9',
    transcript: 'All clear.',
  });
  await settle();
  assert.deepEqual(
    requests.filter((r) => r.url === '/api/elevenlabs/tts').map((r) => r.body.text),
    ['All clear.'],
  );
});

test('new user speech and a cleared output buffer silence the cut-off reply', async () => {
  for (const type of ['input_audio_buffer.speech_started', 'output_audio_buffer.cleared']) {
    const { voice, requests } = build();
    await voice.init();
    voice.observe(delta('Half a sentence'));
    voice.observe({ type });
    voice.observe(delta(' and the rest. '));
    voice.observe({
      type: 'response.output_audio_transcript.done',
      response_id: 'r1',
      transcript: 'Half a sentence and the rest.',
    });
    await settle();
    assert.equal(
      requests.filter((r) => r.url === '/api/elevenlabs/tts').length,
      0,
      `${type} left stale speech`,
    );
  }
});

test('stop() cancels queued speech before it plays', async () => {
  const { voice, played } = build();
  await voice.init();
  voice.observe(delta('One. Two. Three. '));
  voice.stop();
  await settle();
  assert.ok(played.length <= 1);
});

test('does nothing when the server has no key or the user chose OpenAI voice', async () => {
  const off = build({ available: false });
  await off.voice.init();
  off.voice.observe(delta('Hello. '));
  await settle();
  assert.equal(off.voice.enabled, false);
  assert.equal(off.requests.filter((r) => r.url.includes('/tts')).length, 0);

  const chosen = build({ storage: memoryStorage({ 'gev.elevenlabs.enabled': '0' }) });
  await chosen.voice.init();
  chosen.voice.observe(delta('Hello. '));
  await settle();
  assert.equal(chosen.voice.enabled, false);
  assert.equal(chosen.requests.filter((r) => r.url.includes('/tts')).length, 0);
});

function fakeReq({ method = 'GET', body = '', remote = '127.0.0.1' } = {}) {
  const req = new EventEmitter();
  req.method = method;
  req.socket = { remoteAddress: remote };
  req.headers = {};
  req.destroy = () => {};
  queueMicrotask(() => {
    if (body) req.emit('data', Buffer.from(body));
    req.emit('end');
  });
  return req;
}

function fakeRes() {
  const res = new EventEmitter();
  res.headers = {};
  res.chunks = [];
  res.headersSent = false;
  res.setHeader = (k, v) => (res.headers[k.toLowerCase()] = v);
  res.write = (c) => {
    res.chunks.push(Buffer.from(c));
    return true;
  };
  res.end = (c) => {
    if (c) res.chunks.push(Buffer.from(c));
    res.ended = true;
    res.emit('finish');
  };
  return res;
}

const finished = (res) =>
  new Promise((resolve) => (res.ended ? resolve() : res.once('finish', resolve)));
const env = { ELEVEN_LABS_KEY: 'test-key-not-real' };

test('status reports availability and never the key', async () => {
  const res = fakeRes();
  createStatusHandler({ environment: env })(fakeReq(), res);
  await finished(res);
  const body = Buffer.concat(res.chunks).toString();
  assert.equal(JSON.parse(body).available, true);
  assert.equal(JSON.parse(body).defaultVoiceId, 'EXAVITQu4vr4xnSDxMaL');
  assert.ok(!body.includes('test-key-not-real'));
});

test('status is unavailable without a key or from a non-loopback address', async () => {
  const none = fakeRes();
  createStatusHandler({ environment: {} })(fakeReq(), none);
  await finished(none);
  assert.equal(JSON.parse(Buffer.concat(none.chunks)).available, false);
  const remote = fakeRes();
  createStatusHandler({ environment: env })(fakeReq({ remote: '192.168.1.9' }), remote);
  await finished(remote);
  assert.equal(JSON.parse(Buffer.concat(remote.chunks)).available, false);
});

test('tts sends the key upstream only and streams the audio back', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return new Response(new Blob(['mp3-bytes']), { status: 200 });
  };
  const res = fakeRes();
  createTtsHandler({ environment: env, fetchImpl })(
    fakeReq({ method: 'POST', body: JSON.stringify({ text: 'Hi there.', voiceId: 'abcDEF1234567' }) }),
    res,
  );
  await finished(res);
  assert.equal(res.headers['content-type'], 'audio/mpeg');
  assert.equal(Buffer.concat(res.chunks).toString(), 'mp3-bytes');
  assert.match(calls[0].url, /text-to-speech\/abcDEF1234567\/stream/);
  assert.equal(calls[0].init.headers['xi-api-key'], 'test-key-not-real');
  assert.ok(!Buffer.concat(res.chunks).toString().includes('test-key-not-real'));
});

test('tts refuses bad input, other machines and a missing key', async () => {
  const cases = [
    [{ method: 'GET' }, env, 405],
    [{ method: 'POST', body: '{}' }, env, 400],
    [{ method: 'POST', body: JSON.stringify({ text: 'x'.repeat(1001) }) }, env, 413],
    [{ method: 'POST', body: JSON.stringify({ text: 'Hi' }), remote: '10.0.0.5' }, env, 403],
    [{ method: 'POST', body: JSON.stringify({ text: 'Hi' }) }, {}, 503],
  ];
  for (const [reqOpts, environment, status] of cases) {
    const res = fakeRes();
    createTtsHandler({
      environment,
      fetchImpl: async () => {
        throw new Error('must not call upstream');
      },
    })(fakeReq(reqOpts), res);
    await finished(res);
    assert.equal(res.statusCode, status);
  }
});

test('an invalid voiceId falls back to the default instead of reaching the URL', async () => {
  const calls = [];
  const res = fakeRes();
  createTtsHandler({
    environment: env,
    fetchImpl: async (url) => {
      calls.push(url);
      return new Response(new Blob(['x']), { status: 200 });
    },
  })(
    fakeReq({ method: 'POST', body: JSON.stringify({ text: 'Hi', voiceId: '../../etc' }) }),
    res,
  );
  await finished(res);
  assert.match(calls[0], /text-to-speech\/EXAVITQu4vr4xnSDxMaL\/stream/);
});

test('voices lists id, name and category only', async () => {
  const res = fakeRes();
  createVoicesHandler({
    environment: env,
    fetchImpl: async () =>
      Response.json({
        voices: [
          { voice_id: 'abcDEF1234567', name: 'Roger', category: 'premade', samples: [1], secret: 'x' },
          { voice_id: 'bad id', name: 'Skip' },
        ],
      }),
  })(fakeReq(), res);
  await finished(res);
  assert.deepEqual(JSON.parse(Buffer.concat(res.chunks)).voices, [
    { id: 'abcDEF1234567', name: 'Roger', category: 'premade' },
  ]);
});
