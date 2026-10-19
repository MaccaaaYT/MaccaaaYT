// Мия — клиентская часть: чат, голос, настройки, уведомления.
import { api, local, AuthError, setUnauthorizedHandler } from './api.js';
import { Speaker, createListener, blobToBase64, browserSttSupported, recorderSupported } from './voice.js';
import { enablePush, disablePush, syncPush, currentSubscription, pushSupported, isIOS, isStandalone } from './push.js';

const $ = (id) => document.getElementById(id);
const els = {
  app: $('app'),
  fox: $('fox'),
  status: $('status'),
  chat: $('chat'),
  messages: $('messages'),
  composer: $('composer'),
  input: $('input'),
  sendBtn: $('sendBtn'),
  micBtn: $('micBtn'),
  login: $('login'),
  settings: $('settings'),
  toast: $('toast'),
};

const prefs = {
  ttsMode: local.get('ttsMode', 'voice'),
  handsFree: local.get('handsFree', false),
  voiceURI: local.get('voiceURI', ''),
  rate: local.get('rate', 1),
  pitch: local.get('pitch', 1.15),
  sttMode: local.get('sttMode', 'auto'),
};

const state = {
  config: null,
  settings: { userName: '', disabledSlots: [] },
  messages: [],
  busy: false,
  listening: false,
  listener: null,
  lastVia: 'text',
};

const speaker = new Speaker();
Object.assign(speaker, { voiceURI: prefs.voiceURI, rate: prefs.rate, pitch: prefs.pitch });

// ---------- Состояние лисички ----------
const STATUS_TEXT = {
  idle: 'рядом с тобой',
  listening: 'слушаю тебя…',
  thinking: 'думаю…',
  speaking: 'говорю…',
};
function setMood(mood) {
  els.fox.dataset.state = mood;
  els.status.textContent = navigator.onLine ? STATUS_TEXT[mood] : 'нет интернета';
}

let toastTimer;
function toast(text, ms = 3500) {
  els.toast.textContent = text;
  els.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (els.toast.hidden = true), ms);
}

// ---------- Отрисовка сообщений ----------
const dayFmt = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', weekday: 'long' });
const timeFmt = new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit' });

function dayLabel(ts) {
  const d = new Date(ts);
  const today = new Date();
  const yesterday = new Date(Date.now() - 864e5);
  if (d.toDateString() === today.toDateString()) return 'Сегодня';
  if (d.toDateString() === yesterday.toDateString()) return 'Вчера';
  return dayFmt.format(d);
}

function messageEl(m) {
  const el = document.createElement('div');
  el.className = `msg ${m.role === 'user' ? 'user' : 'miya'}${m.error ? ' error' : ''}${m.pending ? ' pending' : ''}`;
  el.dataset.id = m.id;
  if (m.kind === 'proactive') {
    const badge = document.createElement('div');
    badge.className = 'badge';
    badge.textContent = '🔔 Мия написала первой';
    el.append(badge);
  }
  const text = document.createElement('div');
  text.textContent = m.text;
  el.append(text);
  const meta = document.createElement('div');
  meta.className = 'meta';
  meta.textContent = (m.via === 'voice' ? '🎙 ' : '') + timeFmt.format(new Date(m.ts));
  if (m.role !== 'user' && speaker.supported) {
    const replay = document.createElement('button');
    replay.className = 'replay';
    replay.type = 'button';
    replay.title = 'Озвучить';
    replay.setAttribute('aria-label', 'Озвучить');
    replay.textContent = '🔊';
    replay.onclick = () => say(m.text);
    meta.append(replay);
  }
  el.append(meta);
  return el;
}

function renderEmpty() {
  const name = state.settings.userName;
  const box = document.createElement('div');
  box.className = 'empty';
  box.innerHTML = `<p>Привет${name ? ', ' + escapeHtml(name) : ''}! Я Мия 🦊<br>Нажми на микрофон и поговори со мной или просто напиши.</p>`;
  const chips = document.createElement('div');
  chips.className = 'chips';
  for (const t of ['Как ты, Мия?', 'Расскажи свежие новости', 'Расскажи сказку на ночь', 'Что ты обо мне помнишь?']) {
    const c = document.createElement('button');
    c.className = 'chip';
    c.type = 'button';
    c.textContent = t;
    c.onclick = () => send(t, 'text');
    chips.append(c);
  }
  box.append(chips);
  els.messages.append(box);
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function render() {
  els.messages.textContent = '';
  if (!state.messages.length) renderEmpty();
  let lastDay = '';
  for (const m of state.messages) {
    const day = dayLabel(m.ts);
    if (day !== lastDay) {
      const d = document.createElement('div');
      d.className = 'day';
      d.textContent = day;
      els.messages.append(d);
      lastDay = day;
    }
    els.messages.append(messageEl(m));
  }
  els.app.classList.toggle('compact', state.messages.length > 0);
  scrollDown();
}

function scrollDown() {
  requestAnimationFrame(() => (els.chat.scrollTop = els.chat.scrollHeight));
}

function upsert(msgs) {
  const byId = new Map(state.messages.map((m) => [m.id, m]));
  for (const m of msgs) byId.set(m.id, m);
  state.messages = [...byId.values()].sort((a, b) => a.ts - b.ts).slice(-300);
  render();
}

async function loadHistory() {
  const { messages } = await api('history?limit=150');
  state.messages = messages;
  render();
}

async function refreshHistory() {
  const since = state.messages.filter((m) => !m.pending).at(-1)?.ts || 0;
  try {
    const { messages } = await api(`history?since=${since}`);
    if (messages.length) upsert(messages);
  } catch {
    /* офлайн — не страшно */
  }
}

// ---------- Озвучка ----------
function say(text) {
  speaker.unlock();
  return speaker.speak(text, {
    onstart: () => setMood('speaking'),
    onend: () => !state.listening && !state.busy && setMood('idle'),
  });
}

function shouldSpeak(via) {
  return prefs.ttsMode === 'always' || (prefs.ttsMode === 'voice' && via === 'voice');
}

// ---------- Отправка сообщения ----------
async function send(text, via = 'text') {
  text = text.trim();
  if (!text || state.busy) return;
  speaker.unlock();
  speaker.stop();
  state.busy = true;
  state.lastVia = via;
  els.sendBtn.disabled = true;
  const temp = { id: 'tmp-' + Date.now(), role: 'user', text, ts: Date.now(), via, pending: true };
  state.messages.push(temp);
  render();
  setMood('thinking');
  try {
    const { user, reply } = await api('chat', { method: 'POST', body: { text, via } });
    state.messages = state.messages.filter((m) => m.id !== temp.id);
    upsert([user, reply]);
    state.busy = false;
    if (shouldSpeak(via)) {
      await say(reply.text);
      if (via === 'voice' && prefs.handsFree && !state.listening) startListening();
    } else {
      setMood('idle');
    }
  } catch (err) {
    state.messages = state.messages.filter((m) => m.id !== temp.id);
    render();
    if (!(err instanceof AuthError)) {
      els.input.value = els.input.value || text;
      autosize();
      toast(navigator.onLine ? err.message : 'Нет интернета — сообщение не отправлено');
    }
    state.busy = false;
    setMood('idle');
  } finally {
    els.sendBtn.disabled = false;
  }
}

// ---------- Микрофон ----------
const STT_ERRORS = {
  'not-allowed': 'Разреши доступ к микрофону в настройках браузера',
  'service-not-allowed': 'Встроенное распознавание недоступно — переключаюсь на запись через Gemini',
  'audio-capture': 'Не удалось включить микрофон',
  network: 'Распознаванию речи нужен интернет',
  'no-speech': 'Я ничего не услышала… попробуй ещё раз 🦊',
};

function stopListeningUi() {
  state.listening = false;
  els.micBtn.classList.remove('active');
  if (!state.busy && !speaker.speaking) setMood('idle');
}

function startListening() {
  if (state.listening || state.busy) return;
  speaker.unlock();
  speaker.stop();
  const mode = prefs.sttMode === 'auto' ? local.get('sttAutoMode', 'browser') : prefs.sttMode;
  const listener = createListener(mode);
  if (!listener) return toast('Этот браузер не умеет слушать — напиши мне текстом 💛');
  state.listener = listener;
  state.listening = true;
  els.micBtn.classList.add('active');
  setMood('listening');
  const placeholder = els.input.placeholder;
  els.input.placeholder = 'Слушаю…';

  const done = () => {
    els.input.placeholder = placeholder;
    stopListeningUi();
  };
  try {
    listener.start({
      onInterim: (t) => {
        els.input.value = t;
        autosize();
      },
      onResult: (t) => {
        done();
        els.input.value = '';
        autosize();
        send(t, 'voice');
      },
      onAudio: async (blob) => {
        done();
        setMood('thinking');
        els.input.placeholder = 'Разбираю, что ты сказал(а)…';
        try {
          const { text } = await api('transcribe', {
            method: 'POST',
            body: { audio: await blobToBase64(blob), mimeType: blob.type },
          });
          els.input.placeholder = placeholder;
          if (text) send(text, 'voice');
          else {
            setMood('idle');
            toast(STT_ERRORS['no-speech']);
          }
        } catch (err) {
          els.input.placeholder = placeholder;
          setMood('idle');
          toast(err.message);
        }
      },
      onError: (code) => {
        done();
        // В режиме «авто» при отказе встроенного распознавания переходим на запись.
        if (prefs.sttMode === 'auto' && (code === 'service-not-allowed' || code === 'language-not-supported') && recorderSupported) {
          local.set('sttAutoMode', 'gemini');
        }
        if (code !== 'aborted') toast(STT_ERRORS[code] || 'Не получилось расслышать: ' + code);
      },
    });
  } catch (err) {
    done();
    toast('Не удалось включить микрофон');
    console.error(err);
  }
}

els.micBtn.addEventListener('click', () => {
  if (speaker.speaking) {
    speaker.stop();
    setMood('idle');
    return;
  }
  if (state.listening) state.listener?.stop();
  else startListening();
});

// ---------- Ввод текста ----------
function autosize() {
  els.input.style.height = 'auto';
  els.input.style.height = Math.min(els.input.scrollHeight, 140) + 'px';
}
els.input.addEventListener('input', autosize);
els.input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !matchMedia('(pointer: coarse)').matches) {
    e.preventDefault();
    els.composer.requestSubmit();
  }
});
els.composer.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = els.input.value;
  els.input.value = '';
  autosize();
  send(text, 'text');
});

// ---------- Подсказки установки и уведомлений ----------
document.querySelectorAll('[data-close]').forEach((b) =>
  b.addEventListener('click', () => {
    $(b.dataset.close).hidden = true;
    local.set('hidden.' + b.dataset.close, true);
  }),
);

function showHints() {
  if (isIOS && !isStandalone && !local.get('hidden.installHint', false)) {
    $('installHint').hidden = false;
    return;
  }
  if (pushSupported() && state.config?.push && Notification.permission === 'default' && !local.get('hidden.notifyHint', false)) {
    $('notifyHint').hidden = false;
  }
}

$('notifyHintYes').addEventListener('click', async () => {
  $('notifyHint').hidden = true;
  try {
    await enablePush(state.config.vapidPublicKey);
    toast('Ура! Теперь я буду иногда писать тебе первой 💛');
  } catch (err) {
    toast(err.message);
  }
  updatePushStatus();
});

// ---------- Настройки ----------
$('settingsBtn').addEventListener('click', openSettings);

async function openSettings() {
  fillVoiceSettings();
  updatePushStatus();
  renderSlots();
  $('userName').value = state.settings.userName || '';
  const c = state.config || {};
  $('serverInfo').textContent = [
    c.gemini ? 'Gemini подключён' : '⚠️ Нет ключа Gemini (демо-режим)',
    c.persistent ? 'память сохраняется' : '⚠️ нет хранилища — память временная',
    `часовой пояс ${c.timezone}`,
  ].join(' · ');
  els.settings.showModal();
  loadMemory();
}

function fillVoiceSettings() {
  $('ttsMode').value = prefs.ttsMode;
  $('handsFree').checked = prefs.handsFree;
  $('rate').value = prefs.rate;
  $('pitch').value = prefs.pitch;
  $('rateValue').textContent = '×' + Number(prefs.rate).toFixed(2);
  $('pitchValue').textContent = '×' + Number(prefs.pitch).toFixed(2);
  $('sttMode').value = prefs.sttMode;
  $('sttMode').querySelector('[value="browser"]').disabled = !browserSttSupported;
  $('sttMode').querySelector('[value="gemini"]').disabled = !recorderSupported;
  const sel = $('voiceSelect');
  sel.textContent = '';
  const auto = new Option('Автоматически', '');
  sel.append(auto);
  for (const v of speaker.voices) sel.append(new Option(`${v.name}${v.localService ? '' : ' (онлайн)'}`, v.voiceURI));
  sel.value = prefs.voiceURI;
  sel.disabled = !speaker.voices.length;
  if (!speaker.voices.length) auto.textContent = speaker.supported ? 'Русские голоса не найдены' : 'Озвучка не поддерживается';
}
speaker.onvoices = () => els.settings.open && fillVoiceSettings();

function savePref(key, value) {
  prefs[key] = value;
  local.set(key, value);
}

$('ttsMode').addEventListener('change', (e) => savePref('ttsMode', e.target.value));
$('handsFree').addEventListener('change', (e) => savePref('handsFree', e.target.checked));
$('sttMode').addEventListener('change', (e) => {
  savePref('sttMode', e.target.value);
  local.remove('sttAutoMode');
});
$('voiceSelect').addEventListener('change', (e) => {
  savePref('voiceURI', e.target.value);
  speaker.voiceURI = e.target.value;
});
for (const key of ['rate', 'pitch']) {
  $(key).addEventListener('input', (e) => {
    const v = Number(e.target.value);
    savePref(key, v);
    speaker[key] = v;
    $(key + 'Value').textContent = '×' + v.toFixed(2);
  });
}
$('voiceTest').addEventListener('click', () => say('Привет! Я Мия, твоя лисичка. Мне очень приятно с тобой болтать!'));

let nameTimer;
$('userName').addEventListener('input', (e) => {
  clearTimeout(nameTimer);
  nameTimer = setTimeout(() => saveSettings({ userName: e.target.value }), 600);
});

async function saveSettings(patch) {
  try {
    const { settings } = await api('settings', { method: 'POST', body: patch });
    state.settings = settings;
  } catch (err) {
    toast(err.message);
  }
}

function renderSlots() {
  const box = $('slots');
  box.textContent = '';
  for (const s of state.config?.slots || []) {
    const label = document.createElement('label');
    label.className = 'toggle';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = !state.settings.disabledSlots.includes(s.id);
    cb.onchange = () => {
      const disabled = new Set(state.settings.disabledSlots);
      cb.checked ? disabled.delete(s.id) : disabled.add(s.id);
      saveSettings({ disabledSlots: [...disabled] });
    };
    label.append(cb, ` ${s.time} — ${s.title}`);
    box.append(label);
  }
}

async function updatePushStatus() {
  const status = $('pushStatus');
  const enableBtn = $('pushEnable');
  const testBtn = $('pushTest');
  testBtn.disabled = true;
  if (!state.config?.push) {
    status.textContent = 'На сервере не настроены ключи уведомлений (VAPID). Сообщения от Мии появятся в чате при следующем открытии.';
    enableBtn.disabled = true;
    return;
  }
  if (!pushSupported()) {
    status.textContent = isIOS && !isStandalone
      ? 'На iPhone уведомления работают, только если открыть Мию с экрана «Домой» (Поделиться → На экран «Домой»).'
      : 'Этот браузер не поддерживает push-уведомления.';
    enableBtn.disabled = true;
    return;
  }
  const sub = await currentSubscription().catch(() => null);
  if (sub && Notification.permission === 'granted') {
    status.textContent = 'Уведомления включены на этом устройстве ✓';
    enableBtn.textContent = 'Выключить';
    enableBtn.dataset.on = '1';
    testBtn.disabled = false;
  } else {
    status.textContent = Notification.permission === 'denied'
      ? 'Уведомления запрещены в настройках браузера/системы. Разреши их там и вернись сюда.'
      : 'Мия будет напоминать умыться, поесть, размяться и спросит, как прошёл день.';
    enableBtn.textContent = 'Включить уведомления';
    enableBtn.dataset.on = '';
  }
  enableBtn.disabled = Notification.permission === 'denied';
}

$('pushEnable').addEventListener('click', async (e) => {
  try {
    if (e.currentTarget.dataset.on) {
      await disablePush();
      toast('Уведомления на этом устройстве выключены');
    } else {
      await enablePush(state.config.vapidPublicKey);
      toast('Готово! Теперь я буду писать тебе первой 💛');
    }
  } catch (err) {
    toast(err.message);
  }
  updatePushStatus();
});

$('pushTest').addEventListener('click', async () => {
  try {
    const r = await api('subscribe', { method: 'POST', body: { action: 'test' } });
    toast(`Отправлено на устройств: ${r.sent} из ${r.total}`);
  } catch (err) {
    toast(err.message);
  }
});

async function loadMemory() {
  const list = $('facts');
  try {
    const { facts, summary } = await api('memory');
    list.textContent = '';
    if (!facts.length) {
      const li = document.createElement('li');
      li.textContent = 'Пока ничего — расскажи мне о себе 🦊';
      list.append(li);
    }
    for (const f of facts.slice().reverse()) {
      const li = document.createElement('li');
      const span = document.createElement('span');
      span.textContent = f.text;
      const del = document.createElement('button');
      del.type = 'button';
      del.textContent = '✕';
      del.setAttribute('aria-label', 'Забыть');
      del.onclick = async () => {
        await api(`memory?id=${encodeURIComponent(f.id)}`, { method: 'DELETE' });
        loadMemory();
      };
      li.append(span, del);
      list.append(li);
    }
    $('summaryText').textContent = summary || 'Пока пусто — резюме появится, когда мы много поболтаем.';
  } catch (err) {
    list.textContent = err.message;
  }
}

$('clearFacts').addEventListener('click', async () => {
  if (!confirm('Мия забудет всё, что знает о тебе. Точно?')) return;
  await api('memory', { method: 'DELETE' });
  loadMemory();
});
$('clearHistory').addEventListener('click', async () => {
  if (!confirm('Удалить всю переписку и резюме разговоров? Факты о тебе останутся.')) return;
  await api('history', { method: 'DELETE' });
  state.messages = [];
  render();
  loadMemory();
});
$('logout').addEventListener('click', async () => {
  await disablePush().catch(() => {});
  local.remove('token');
  location.reload();
});

// ---------- Вход ----------
function showLogin() {
  els.login.hidden = false;
  setTimeout(() => $('password').focus(), 50);
}
setUnauthorizedHandler(() => {
  local.remove('token');
  showLogin();
});

$('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const password = $('password').value;
  const { ok } = await api('config', { method: 'POST', body: { password } }).catch(() => ({ ok: false }));
  if (!ok) {
    $('loginError').hidden = false;
    return;
  }
  local.set('token', password);
  els.login.hidden = true;
  start();
});

// ---------- Запуск ----------
async function start() {
  try {
    const [{ settings }] = await Promise.all([api('settings'), loadHistory()]);
    state.settings = settings;
    if (!state.messages.length) render();
  } catch (err) {
    if (!(err instanceof AuthError)) toast(err.message);
    return;
  }
  setMood('idle');
  showHints();
  syncPush(state.config.vapidPublicKey);
  // Открыли из уведомления — подсветим сообщение.
  const highlight = new URLSearchParams(location.search).get('m');
  if (highlight) history.replaceState(null, '', '/');
}

async function init() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch((err) => console.warn('SW:', err));
    navigator.serviceWorker.addEventListener('message', (e) => e.data?.type === 'refresh' && refreshHistory());
  }
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && refreshHistory());
  window.addEventListener('online', () => setMood(els.fox.dataset.state));
  window.addEventListener('offline', () => setMood(els.fox.dataset.state));

  try {
    state.config = await api('config');
  } catch {
    toast('Не удалось связаться с сервером');
    return;
  }
  if (state.config.authRequired && !local.get('token', '')) return showLogin();
  start();
}

init();
