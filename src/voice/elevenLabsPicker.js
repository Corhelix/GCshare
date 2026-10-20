import { elevenLabsVoice } from './elevenLabsVoice.js';

/**
 * Voice picker in the AI AGENT panel. Stays hidden unless the server has an
 * ElevenLabs key. "OPENAI" keeps OpenAI's own voice; any other entry is an
 * ElevenLabs voice from the account. Applies from the next reply.
 */
export async function mountElevenLabsPicker(root, voice = elevenLabsVoice) {
  const select = root?.querySelector('#gev-voice-eleven');
  if (!select) return;
  try {
    if (!(await voice.init())) return;
    const voices = await voice.listVoices();
    if (!voices.length) return;
    select.replaceChildren();
    const openai = document.createElement('option');
    openai.value = '';
    openai.textContent = 'OPENAI VOICE';
    select.append(openai);
    for (const entry of voices) {
      const option = document.createElement('option');
      option.value = entry.id;
      option.textContent = entry.name.toUpperCase();
      select.append(option);
    }
    select.value = voice.enabled ? voice.voiceId || '' : '';
    if (select.value !== (voice.enabled ? voice.voiceId : ''))
      select.value = '';
    select.hidden = false;
    select.addEventListener('change', () => {
      if (!select.value) {
        voice.setEnabled(false);
        return;
      }
      voice.setVoiceId(select.value);
      voice.setEnabled(true);
    });
  } catch {
    select.hidden = true;
  }
}
