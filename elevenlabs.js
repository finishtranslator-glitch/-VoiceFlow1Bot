// elevenlabs.js
// Thin wrapper around the ElevenLabs API: list voices, text-to-speech, voice cloning.

const axios = require('axios');
const FormData = require('form-data');

const BASE_URL = 'https://api.elevenlabs.io/v1';

function client() {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) {
    throw new Error('ELEVENLABS_API_KEY is not set in environment variables.');
  }
  return axios.create({
    baseURL: BASE_URL,
    headers: { 'xi-api-key': apiKey },
  });
}

// Returns a list of { voice_id, name, category }
async function listVoices() {
  const api = client();
  const { data } = await api.get('/voices');
  return (data.voices || []).map((v) => ({
    voice_id: v.voice_id,
    name: v.name,
    category: v.category,
  }));
}

// Generates speech audio (mp3 Buffer) for given text + voice_id
async function textToSpeech(text, voiceId, opts = {}) {
  const api = client();
  const response = await api.post(
    `/text-to-speech/${voiceId}`,
    {
      text,
      model_id: opts.modelId || 'eleven_multilingual_v2',
      voice_settings: {
        stability: opts.stability ?? 0.5,
        similarity_boost: opts.similarityBoost ?? 0.75,
      },
    },
    { responseType: 'arraybuffer' }
  );
  return Buffer.from(response.data);
}

// Clones a voice from one or more audio sample buffers.
// samples: array of { buffer, filename }
async function cloneVoice(name, samples, description = '') {
  const api = client();
  const form = new FormData();
  form.append('name', name);
  if (description) form.append('description', description);
  for (const sample of samples) {
    form.append('files', sample.buffer, sample.filename || 'sample.ogg');
  }
  const { data } = await api.post('/voices/add', form, {
    headers: form.getHeaders(),
  });
  return data; // { voice_id, name, ... }
}

async function deleteVoice(voiceId) {
  const api = client();
  await api.delete(`/voices/${voiceId}`);
}

module.exports = { listVoices, textToSpeech, cloneVoice, deleteVoice };
