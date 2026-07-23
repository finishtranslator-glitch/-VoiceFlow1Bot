// index.js
// VoiceFlow Telegram Bot — PlayHT-style text-to-speech + voice cloning via ElevenLabs.

require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const axios = require('axios');
const elevenlabs = require('./elevenlabs');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error('Missing TELEGRAM_BOT_TOKEN in environment variables.');
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);

// --- In-memory per-user state (MVP only — resets on restart/redeploy) ---
// For real persistence, swap this Map for Railway's Postgres/Redis addon.
const userState = new Map();
function getState(userId) {
  if (!userState.has(userId)) {
    userState.set(userId, { selectedVoiceId: null, selectedVoiceName: null, awaitingCloneName: false, awaitingCloneSample: false, pendingCloneName: null });
  }
  return userState.get(userId);
}

// --- Helpers ---
async function downloadTelegramFile(ctx, fileId) {
  const link = await ctx.telegram.getFileLink(fileId);
  const response = await axios.get(link.href, { responseType: 'arraybuffer' });
  return Buffer.from(response.data);
}

function voiceKeyboard(voices, prefix) {
  const buttons = voices.map((v) => Markup.button.callback(v.name, `${prefix}:${v.voice_id}`));
  const rows = [];
  for (let i = 0; i < buttons.length; i += 2) rows.push(buttons.slice(i, i + 2));
  return Markup.inlineKeyboard(rows);
}

// --- Commands ---

bot.start((ctx) => {
  ctx.reply(
    "🎙️ Welcome to VoiceFlow!\n\n" +
    "I turn text into natural speech, and can clone a voice from a sample you send me.\n\n" +
    "Commands:\n" +
    "/voices — pick a voice to speak with\n" +
    "/speak <text> — generate speech (or just send me any text)\n" +
    "/clone <name> — clone a new voice from an audio sample\n" +
    "/myvoice — see your currently selected voice"
  );
});

bot.command('voices', async (ctx) => {
  try {
    await ctx.reply('Fetching available voices…');
    const voices = await elevenlabs.listVoices();
    if (!voices.length) return ctx.reply('No voices found on this ElevenLabs account.');
    await ctx.reply('Choose a voice:', voiceKeyboard(voices, 'setvoice'));
  } catch (err) {
    console.error(err);
    ctx.reply('Could not fetch voices. Check the ElevenLabs API key.');
  }
});

bot.action(/setvoice:(.+)/, async (ctx) => {
  const voiceId = ctx.match[1];
  try {
    const voices = await elevenlabs.listVoices();
    const voice = voices.find((v) => v.voice_id === voiceId);
    const state = getState(ctx.from.id);
    state.selectedVoiceId = voiceId;
    state.selectedVoiceName = voice ? voice.name : voiceId;
    await ctx.answerCbQuery();
    await ctx.editMessageText(`✅ Voice set to: ${state.selectedVoiceName}`);
  } catch (err) {
    console.error(err);
    ctx.answerCbQuery('Error setting voice');
  }
});

bot.command('myvoice', (ctx) => {
  const state = getState(ctx.from.id);
  if (!state.selectedVoiceId) return ctx.reply('No voice selected yet. Use /voices to pick one.');
  ctx.reply(`Current voice: ${state.selectedVoiceName}`);
});

bot.command('speak', async (ctx) => {
  const text = ctx.message.text.replace(/^\/speak(@\w+)?\s*/, '').trim();
  if (!text) return ctx.reply('Usage: /speak <text you want spoken>');
  await generateAndSendSpeech(ctx, text);
});

// Voice cloning flow: /clone <name>  →  then send an audio/voice sample
bot.command('clone', async (ctx) => {
  const name = ctx.message.text.replace(/^\/clone(@\w+)?\s*/, '').trim();
  if (!name) return ctx.reply('Usage: /clone <name for the new voice>, then send a voice/audio sample (10s+ recommended).');
  const state = getState(ctx.from.id);
  state.awaitingCloneSample = true;
  state.pendingCloneName = name;
  ctx.reply(`Got it. Now send me a voice message or audio file to clone as "${name}".`);
});

// Handle incoming audio/voice messages — either a clone sample, or ignored otherwise
bot.on(['voice', 'audio', 'document'], async (ctx) => {
  const state = getState(ctx.from.id);
  if (!state.awaitingCloneSample) {
    return ctx.reply('Send /clone <name> first if you want to clone this as a voice.');
  }
  try {
    const fileId =
      ctx.message.voice?.file_id || ctx.message.audio?.file_id || ctx.message.document?.file_id;
    if (!fileId) return ctx.reply('Could not read that file. Try sending a voice note or audio file.');

    await ctx.reply('Cloning voice… this can take a few moments.');
    const buffer = await downloadTelegramFile(ctx, fileId);
    const result = await elevenlabs.cloneVoice(state.pendingCloneName, [
      { buffer, filename: 'sample.ogg' },
    ]);

    state.awaitingCloneSample = false;
    state.selectedVoiceId = result.voice_id;
    state.selectedVoiceName = state.pendingCloneName;
    state.pendingCloneName = null;

    ctx.reply(`🎉 Voice "${result.name}" cloned and selected! Use /speak <text> to try it.`);
  } catch (err) {
    console.error(err.response?.data || err);
    ctx.reply('Voice cloning failed. Make sure the sample is clear audio, at least a few seconds long.');
  }
});

// Plain text messages (not commands) → speak directly with selected voice
bot.on('text', async (ctx) => {
  if (ctx.message.text.startsWith('/')) return; // unknown command, ignore
  await generateAndSendSpeech(ctx, ctx.message.text);
});

async function generateAndSendSpeech(ctx, text) {
  const state = getState(ctx.from.id);
  if (!state.selectedVoiceId) {
    return ctx.reply('Pick a voice first with /voices, or clone one with /clone <name>.');
  }
  if (text.length > 1000) {
    return ctx.reply('That text is a bit long — please keep it under 1000 characters per message.');
  }
  try {
    await ctx.sendChatAction('record_voice');
    const audioBuffer = await elevenlabs.textToSpeech(text, state.selectedVoiceId);
    await ctx.replyWithVoice({ source: audioBuffer, filename: 'speech.mp3' });
  } catch (err) {
    console.error(err.response?.data || err);
    ctx.reply('Something went wrong generating speech. Please try again.');
  }
}

bot.catch((err, ctx) => {
  console.error(`Bot error for ${ctx.updateType}:`, err);
});

bot.launch();
console.log('VoiceFlow bot is running…');

// Graceful shutdown
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
