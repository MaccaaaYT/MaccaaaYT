// Голос: озвучка (speechSynthesis) и распознавание речи (Web Speech API
// или запись звука с расшифровкой через Gemini на сервере).

const SR = window.SpeechRecognition || window.webkitSpeechRecognition;

/** Убираем из текста то, что не нужно читать вслух. */
export function speakable(text) {
  return text
    .replace(/https?:\/\/\S+/g, '')
    .replace(/[*_#`~>|]/g, '')
    .replace(/\p{Extended_Pictographic}(‍\p{Extended_Pictographic}|️)*/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Делим на куски по предложениям: Chrome обрывает длинные фразы. */
function chunks(text, max = 180) {
  const sentences = text.match(/[^.!?…]+[.!?…]*\s*/g) || [text];
  const out = [];
  let cur = '';
  for (const s of sentences) {
    if ((cur + s).length > max && cur) {
      out.push(cur.trim());
      cur = '';
    }
    cur += s;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

// Предпочтительные русские женские голоса на разных платформах.
const PREFERRED = [
  /milena|милена/i, // macOS / iOS
  /google русский|google russian/i, // Chrome
  /svetlana|dariya|irina|дария|светлана|ирина/i, // Windows / Edge
  /katya|катя|alyona|алёна|yuliya|юлия/i,
  /female|женск/i,
];

export class Speaker {
  constructor() {
    this.supported = 'speechSynthesis' in window;
    this.voices = [];
    this.voiceURI = '';
    this.rate = 1;
    this.pitch = 1.15;
    this.speaking = false;
    this.onvoices = () => {};
    if (!this.supported) return;
    const load = () => {
      this.voices = speechSynthesis.getVoices().filter((v) => v.lang?.toLowerCase().startsWith('ru'));
      this.onvoices(this.voices);
    };
    load();
    speechSynthesis.addEventListener?.('voiceschanged', load);
  }

  pickVoice() {
    if (!this.voices.length) return null;
    const chosen = this.voices.find((v) => v.voiceURI === this.voiceURI);
    if (chosen) return chosen;
    for (const re of PREFERRED) {
      const v = this.voices.find((x) => re.test(x.name));
      if (v) return v;
    }
    return this.voices[0];
  }

  /** iOS разрешает озвучку только после жеста пользователя — «будим» синтез. */
  unlock() {
    if (!this.supported || this.unlocked) return;
    this.unlocked = true;
    const u = new SpeechSynthesisUtterance(' ');
    u.volume = 0;
    speechSynthesis.speak(u);
  }

  stop() {
    if (!this.supported) return;
    this.token = null;
    speechSynthesis.cancel();
    if (this.speaking) {
      this.speaking = false;
      this.onend?.();
    }
  }

  speak(text, { onstart, onend } = {}) {
    if (!this.supported) return Promise.resolve();
    this.stop();
    const clean = speakable(text);
    if (!clean) return Promise.resolve();
    const token = (this.token = {});
    const parts = chunks(clean);
    const voice = this.pickVoice();
    this.onend = onend;

    return new Promise((resolve) => {
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        clearTimeout(watchdog);
        if (this.token === token) {
          this.speaking = false;
          this.onend = null;
          onend?.();
        }
        resolve();
      };
      // Safari иногда не присылает onend — страхуемся по примерной длительности.
      const watchdog = setTimeout(finish, clean.length * 110 / this.rate + 4000);
      parts.forEach((part, i) => {
        const u = new SpeechSynthesisUtterance(part);
        u.lang = voice?.lang || 'ru-RU';
        if (voice) u.voice = voice;
        u.rate = this.rate;
        u.pitch = this.pitch;
        if (i === 0) {
          u.onstart = () => {
            this.speaking = true;
            onstart?.();
          };
        }
        if (i === parts.length - 1) u.onend = finish;
        u.onerror = (e) => {
          if (e.error !== 'interrupted' && e.error !== 'canceled') console.warn('TTS error', e.error);
          if (i === parts.length - 1 || e.error === 'not-allowed') finish();
        };
        speechSynthesis.speak(u);
      });
      // Chrome иногда «засыпает» с очередью — пинаем.
      if (speechSynthesis.paused) speechSynthesis.resume();
    });
  }
}

/** Распознавание через встроенный Web Speech API. */
class BrowserListener {
  start({ onInterim, onResult, onError }) {
    const rec = (this.rec = new SR());
    rec.lang = 'ru-RU';
    rec.interimResults = true;
    rec.continuous = false;
    rec.maxAlternatives = 1;
    let finalText = '';
    let latest = '';
    let error = null;
    rec.onresult = (e) => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) finalText += r[0].transcript;
        else interim += r[0].transcript;
      }
      latest = (finalText + interim).trim();
      onInterim?.(latest);
    };
    rec.onerror = (e) => (error = e.error);
    rec.onend = () => {
      this.rec = null;
      const text = (finalText.trim() || latest).trim();
      if (text) onResult(text);
      else onError(error || 'no-speech');
    };
    rec.start();
  }
  stop() {
    this.rec?.stop();
  }
  abort() {
    if (this.rec) {
      this.rec.onend = null;
      this.rec.abort();
      this.rec = null;
    }
  }
}

/** Запись звука с автоостановкой по тишине; текст получаем на сервере через Gemini. */
class RecorderListener {
  async start({ onLevel, onAudio, onError }) {
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    } catch (err) {
      onError(err.name === 'NotAllowedError' ? 'not-allowed' : 'audio-capture');
      return;
    }
    const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'].find(
      (t) => window.MediaRecorder?.isTypeSupported?.(t),
    );
    const recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    const parts = [];
    this.recorder = recorder;
    this.cancelled = false;

    // Простое определение тишины.
    const Ctx = window.AudioContext || window.webkitAudioContext;
    const ctx = new Ctx();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    ctx.createMediaStreamSource(stream).connect(analyser);
    const buf = new Float32Array(analyser.fftSize);
    const started = Date.now();
    let heard = false;
    let lastVoice = Date.now();
    this.timer = setInterval(() => {
      analyser.getFloatTimeDomainData(buf);
      let sum = 0;
      for (const x of buf) sum += x * x;
      const rms = Math.sqrt(sum / buf.length);
      onLevel?.(rms);
      const now = Date.now();
      if (rms > 0.02) {
        heard = true;
        lastVoice = now;
      }
      if ((heard && now - lastVoice > 1600) || (!heard && now - started > 8000) || now - started > 45000) this.stop();
    }, 100);

    recorder.ondataavailable = (e) => e.data.size && parts.push(e.data);
    recorder.onstop = async () => {
      clearInterval(this.timer);
      stream.getTracks().forEach((t) => t.stop());
      ctx.close?.();
      this.recorder = null;
      if (this.cancelled) return;
      if (!heard) return onError('no-speech');
      const blob = new Blob(parts, { type: recorder.mimeType || mime || 'audio/webm' });
      onAudio(blob);
    };
    recorder.start(250);
  }
  stop() {
    if (this.recorder?.state === 'recording') this.recorder.stop();
  }
  abort() {
    this.cancelled = true;
    this.stop();
  }
}

export const browserSttSupported = Boolean(SR);
export const recorderSupported = Boolean(navigator.mediaDevices?.getUserMedia && window.MediaRecorder);

export function createListener(mode) {
  if (mode === 'browser' && browserSttSupported) return new BrowserListener();
  if (mode === 'gemini' && recorderSupported) return new RecorderListener();
  if (browserSttSupported) return new BrowserListener();
  if (recorderSupported) return new RecorderListener();
  return null;
}

export function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] || '');
    r.onerror = reject;
    r.readAsDataURL(blob);
  });
}
