/* EGY Animal ID — nose-print proof of concept (page logic). */
'use strict';

const SIZE = 512;
const MIN_KP_ENROLL = 200;   // texture needed to accept a registration photo
const MIN_KP_QUERY = 120;    // texture needed to attempt identification
const AR = new Intl.NumberFormat('ar-EG-u-nu-latn');
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const num = (n) => AR.format(n);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ storage */
const DB = {
  db: null,
  open() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open('egy-animal-id', 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        db.createObjectStore('dogs', { keyPath: 'id' });
        db.createObjectStore('attempts', { keyPath: 'id' });
      };
      req.onsuccess = () => { this.db = req.result; resolve(); };
      req.onerror = () => reject(req.error);
    });
  },
  tx(store, mode, fn) {
    return new Promise((resolve, reject) => {
      const t = this.db.transaction(store, mode);
      const s = t.objectStore(store);
      const out = fn(s);
      t.oncomplete = () => resolve(out && out.result !== undefined ? out.result : undefined);
      t.onerror = () => reject(t.error);
    });
  },
  all(store) { return this.tx(store, 'readonly', (s) => s.getAll()); },
  put(store, v) { return this.tx(store, 'readwrite', (s) => s.put(v)); },
  del(store, k) { return this.tx(store, 'readwrite', (s) => s.delete(k)); },
  clear(store) { return this.tx(store, 'readwrite', (s) => s.clear()); },
};

const state = { dogs: [], attempts: [], urls: new Map() };

function blobUrl(blob) {
  if (!blob) return '';
  if (!state.urls.has(blob)) state.urls.set(blob, URL.createObjectURL(blob));
  return state.urls.get(blob);
}
const dogById = (id) => state.dogs.find((d) => d.id === id);

async function loadData() {
  state.dogs = (await DB.all('dogs')).sort((a, b) => a.createdAt - b.createdAt);
  state.attempts = (await DB.all('attempts')).sort((a, b) => b.at - a.at);
}

/* ------------------------------------------------------------------ engine */
const Engine = {
  worker: null, ready: false, seq: 0, pending: new Map(), waiters: [],
  start() {
    this.worker = new Worker('worker.js');
    this.worker.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'progress') {
        $('#engine-fill').style.width = m.pct + '%';
        $('#engine-text').textContent = m.pct < 100 ? `جاري تحميل محرك التعرف… ${num(m.pct)}%` : 'المحرك جاهز';
        return;
      }
      if (m.type === 'ready') {
        this.ready = true;
        $('#engine').classList.add('done');
        this.waiters.splice(0).forEach((f) => f());
        return;
      }
      if (m.type === 'fatal') {
        $('#engine-text').textContent = 'تعذر تحميل محرك التعرف — تحقق من الإنترنت ثم أعد فتح التطبيق';
        return;
      }
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      m.ok ? p.resolve(m) : p.reject(new Error(m.message));
    };
  },
  whenReady() { return this.ready ? Promise.resolve() : new Promise((r) => this.waiters.push(r)); },
  call(type, payload = {}, transfer = []) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, type, ...payload }, transfer);
    });
  },
  async extract(canvas) {
    const gray = toGray(canvas);
    const r = await this.call('extract', { gray }, [gray.buffer]);
    return r.features;
  },
  syncGallery() {
    const gallery = state.dogs.map((d) => ({ id: d.id, templates: d.features }));
    return this.call('setGallery', { gallery });
  },
};

function toGray(canvas) {
  const d = canvas.getContext('2d').getImageData(0, 0, SIZE, SIZE).data;
  const g = new Uint8Array(SIZE * SIZE);
  for (let i = 0, j = 0; j < g.length; i += 4, j++) g[j] = (d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) >> 8;
  return g;
}

/* ------------------------------------------------------------------ ui helpers */
function toast(text, ms = 2600) {
  const t = $('#toast');
  t.textContent = text; t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (t.hidden = true), ms);
}
function busy(text) {
  $('#busy-text').textContent = text || 'جاري التحليل…';
  $('#busy').hidden = !text;
}
function canvasToBlob(canvas, q = 0.9) {
  return new Promise((r) => canvas.toBlob(r, 'image/jpeg', q));
}
function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}
async function fileToPhotoBlob(file, max = 900) {
  const url = URL.createObjectURL(file);
  try {
    const img = await loadImage(url);
    const s = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas');
    c.width = Math.round(img.naturalWidth * s); c.height = Math.round(img.naturalHeight * s);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    return await canvasToBlob(c, 0.85);
  } finally { URL.revokeObjectURL(url); }
}
function strengthOf(score) {
  if (score >= 80) return { label: 'تطابق قوي جداً', cls: 'ok' };
  if (score >= 40) return { label: 'تطابق قوي', cls: 'ok' };
  if (score >= 18) return { label: 'تطابق مقبول', cls: 'warn' };
  return { label: 'ضعيف', cls: 'bad' };
}
function dogSubtitle(d) {
  return [d.breed, d.sex, d.age].filter(Boolean).join(' · ') || 'بدون تفاصيل';
}
function shortId(id) { return 'EG-' + id.replace(/-/g, '').slice(0, 8).toUpperCase(); }

/* ------------------------------------------------------------------ router */
const TITLES = {
  home: 'تجربة بصمة الأنف', register: 'تسجيل كلب جديد', enroll: 'تصوير بصمة الأنف', result: 'نتيجة التعرف',
  dogs: 'الكلاب المسجلة', dog: 'ملف الكلب', results: 'نتائج الاختبار', help: 'طريقة الاختبار',
};
const TAB_OF = { home: 'home', dogs: 'dogs', dog: 'dogs', results: 'results', help: 'help', result: 'identify', register: 'dogs', enroll: 'dogs' };
let current = 'home';

function show(name, mode = 'push') {
  if (name === 'identify') return startIdentify();
  $$('.screen').forEach((s) => (s.hidden = s.id !== 's-' + name));
  $('#screen-title').textContent = TITLES[name] || '';
  $('#btn-back').hidden = name === 'home';
  $$('#tabbar button').forEach((b) => b.classList.toggle('on', b.dataset.go === TAB_OF[name]));
  current = name;
  if (mode === 'push') history.pushState({ name }, '');
  else if (mode === 'replace') history.replaceState({ name }, '');
  window.scrollTo(0, 0);
  if (name === 'home') renderHome();
  if (name === 'dogs') renderDogs();
  if (name === 'results') renderResults();
  if (name === 'register' && mode !== 'none') resetRegister();
}
window.addEventListener('popstate', (e) => {
  if (Camera.afterPop) { const f = Camera.afterPop; Camera.afterPop = null; f(); return; }
  if (!$('#camera').hidden) { Camera.close(null); return; }
  show((e.state && e.state.name) || 'home', 'none');
});
document.addEventListener('click', (e) => {
  const go = e.target.closest('[data-go]');
  if (go) { e.preventDefault(); show(go.dataset.go); }
});
$('#btn-back').onclick = () => history.back();
$('#btn-help').onclick = () => show('help');

/* ------------------------------------------------------------------ home */
function renderHome() {
  $('#st-dogs').textContent = num(state.dogs.length);
  $('#st-dogs-goal').textContent = state.dogs.length >= 10 ? 'اكتمل الهدف ✓' : `الهدف 10 — باقي ${num(10 - state.dogs.length)}`;
  const m = metrics();
  $('#st-tests').textContent = num(m.total);
  $('#st-acc').textContent = m.regTotal ? `دقة ${num(Math.round((m.correct / m.regTotal) * 100))}%` : 'لا توجد محاولات بعد';
}

/* ------------------------------------------------------------------ camera */
const Camera = {
  stream: null, track: null, devices: [], devIndex: 0, loop: 0, recentMax: 0, resolve: null, shooting: false, afterPop: null, hwZoom: false,
  work: document.createElement('canvas'),
  crop: document.createElement('canvas'),

  open(title) {
    return new Promise(async (resolve) => {
      this.resolve = resolve;
      $('#cam-title').textContent = title;
      $('#camera').hidden = false;
      $('#cam-confirm').hidden = true;
      $('#cropper').hidden = true;
      history.pushState({ name: current, cam: true }, '');
      await this.startStream();
    });
  },

  async startStream() {
    this.stop();
    const v = $('#cam-video');
    const dev = this.devices[this.devIndex];
    const video = dev
      ? { deviceId: { exact: dev.deviceId }, width: { ideal: 3840 }, height: { ideal: 2160 } }
      : { facingMode: { ideal: 'environment' }, width: { ideal: 3840 }, height: { ideal: 2160 } };
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ video, audio: false });
    } catch (err) {
      $('#cam-tip').textContent = 'تعذر فتح الكاميرا. اسمح للتطبيق باستخدام الكاميرا، أو اختر صورة من المعرض.';
      $('#cam-quality').textContent = 'لا توجد كاميرا';
      $('#cam-quality').className = 'pill bad';
      $('#cam-switch').style.visibility = 'hidden';
      return;
    }
    v.srcObject = this.stream;
    this.track = this.stream.getVideoTracks()[0];
    try { await v.play(); } catch (_) {}
    if (!this.devices.length) {
      try {
        this.devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
        const cur = this.track.getSettings().deviceId;
        this.devIndex = Math.max(0, this.devices.findIndex((d) => d.deviceId === cur));
      } catch (_) {}
    }
    $('#cam-switch').style.visibility = this.devices.length > 1 ? 'visible' : 'hidden';
    this.setupControls();
    this.recentMax = 0;
    this.meter();
  },

  setupControls() {
    const caps = (this.track.getCapabilities && this.track.getCapabilities()) || {};
    const adv = [];
    if (caps.focusMode && caps.focusMode.includes('continuous')) adv.push({ focusMode: 'continuous' });
    if (adv.length) this.track.applyConstraints({ advanced: adv }).catch(() => {});
    const torch = $('#cam-torch');
    torch.hidden = !caps.torch;
    torch.classList.remove('on');
    // Zoom lets the nose fill the ring from a distance the camera can still focus at.
    // Hardware zoom where the browser exposes it, otherwise digital zoom on the preview
    // (the crop mapping in ringRect() follows the scaled video box automatically).
    const z = $('#cam-zoom');
    $('#cam-zoom-wrap').hidden = false;
    $('#cam-video').style.setProperty('--z', 1);
    this.hwZoom = !!(caps.zoom && caps.zoom.max > caps.zoom.min);
    if (this.hwZoom) {
      z.min = caps.zoom.min; z.max = Math.min(caps.zoom.max, 5); z.step = caps.zoom.step || 0.1;
      z.value = this.track.getSettings().zoom || caps.zoom.min;
    } else {
      z.min = 1; z.max = 3; z.step = 0.05; z.value = 1;
    }
  },

  stop() {
    cancelAnimationFrame(this.loop);
    if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
    this.stream = null; this.track = null;
  },

  close(result) {
    this.stop();
    $('#camera').hidden = true;
    const r = this.resolve; this.resolve = null;
    const done = () => r && r(result);
    if (history.state && history.state.cam) { this.afterPop = done; history.back(); }
    else done();
  },

  // Maps the on-screen guide ring to a square in video pixels.
  ringRect() {
    const v = $('#cam-video');
    const VW = v.videoWidth, VH = v.videoHeight;
    if (!VW) return null;
    const box = v.getBoundingClientRect();
    const s = Math.max(box.width / VW, box.height / VH);
    const ox = box.left + (box.width - VW * s) / 2, oy = box.top + (box.height - VH * s) / 2;
    const r = $('#cam-ring').getBoundingClientRect();
    const inset = 4;
    return { x: (r.left + inset - ox) / s, y: (r.top + inset - oy) / s, d: (r.width - 2 * inset) / s };
  },

  grab(target, size) {
    const rr = this.ringRect();
    if (!rr) return false;
    target.width = target.height = size;
    target.getContext('2d', { willReadFrequently: true }).drawImage($('#cam-video'), rr.x, rr.y, rr.d, rr.d, 0, 0, size, size);
    return true;
  },

  meter() {
    let last = 0;
    const tick = (t) => {
      this.loop = requestAnimationFrame(tick);
      if (t - last < 180 || this.shooting) return;
      last = t;
      if (!this.grab(this.work, 160)) return;
      const q = quality(this.work);
      this.recentMax = Math.max(q.sharp, this.recentMax * 0.97);
      let level = 'bad', label = 'غير واضح', tip = 'على بعد 15–20 سم، استخدم التكبير حتى يملأ الأنف الدائرة';
      if (q.mean < 28) { level = 'bad'; label = 'مظلم'; tip = 'الإضاءة ضعيفة — انتقل لمكان أكثر إضاءة أو شغّل الفلاش'; }
      else if (q.mean > 215) { level = 'warn'; label = 'لمعان'; tip = 'الضوء قوي جداً على الأنف — غيّر الزاوية قليلاً'; }
      else if (q.sharp >= 100 && q.sharp >= 0.72 * this.recentMax) { level = 'ok'; label = 'واضح'; tip = 'ممتاز — ثبّت يدك واضغط التصوير'; }
      else if (q.sharp >= 60) { level = 'warn'; label = 'متوسط'; tip = 'ثبّت يدك لحظة حتى يركز الهاتف'; }
      $('#cam-ring').dataset.q = level;
      const pill = $('#cam-quality');
      pill.textContent = label; pill.className = 'pill ' + level;
      $('#cam-tip').textContent = tip;
    };
    this.loop = requestAnimationFrame(tick);
  },

  // Burst for ~1.1 s and keep the sharpest frame.
  async shoot() {
    if (this.shooting || !this.stream) return;
    this.shooting = true;
    $('#cam-shoot').classList.add('busy');
    let best = -1;
    const probe = document.createElement('canvas');
    const t0 = performance.now();
    while (performance.now() - t0 < 1100) {
      if (this.grab(probe, 256)) {
        const q = quality(probe);
        if (q.sharp > best) { best = q.sharp; this.grab(this.crop, SIZE); }
      }
      await sleep(60);
    }
    $('#cam-shoot').classList.remove('busy');
    this.shooting = false;
    if (best < 0) return;
    this.confirm();
  },

  confirm() {
    const pv = $('#cam-preview');
    pv.getContext('2d').drawImage(this.crop, 0, 0);
    const q = quality(this.crop);
    $('#cam-confirm-msg').textContent = q.mean < 28
      ? 'الصورة مظلمة — يفضّل إعادة التصوير في إضاءة أفضل.'
      : 'هل الصورة واضحة ويظهر فيها نسيج الأنف؟';
    $('#cam-confirm').hidden = false;
  },

  use() {
    const out = document.createElement('canvas');
    out.width = out.height = SIZE;
    out.getContext('2d').drawImage(this.crop, 0, 0);
    this.close(out);
  },
};

// Sharpness (variance of Laplacian) and mean brightness of a small canvas.
function quality(canvas) {
  const w = canvas.width, h = canvas.height;
  const d = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, w, h).data;
  const g = new Float32Array(w * h);
  let sum = 0;
  for (let i = 0, j = 0; j < g.length; i += 4, j++) { g[j] = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]; sum += g[j]; }
  // scale-normalise: measure on a 160px grid regardless of input size
  const step = w / 160;
  let n = 0, s1 = 0, s2 = 0;
  for (let y = 1; y < 159; y++) {
    for (let x = 1; x < 159; x++) {
      const at = (xx, yy) => g[Math.floor(yy * step) * w + Math.floor(xx * step)];
      const L = 4 * at(x, y) - at(x - 1, y) - at(x + 1, y) - at(x, y - 1) - at(x, y + 1);
      s1 += L; s2 += L * L; n++;
    }
  }
  const mean = s1 / n;
  return { sharp: s2 / n - mean * mean, mean: sum / g.length };
}

$('#cam-shoot').onclick = () => Camera.shoot();
$('#cam-retake').onclick = () => { $('#cam-confirm').hidden = true; };
$('#cam-use').onclick = () => Camera.use();
$('#cam-close').onclick = () => Camera.close(null);
$('#cam-switch').onclick = async () => {
  if (Camera.devices.length < 2) return;
  Camera.devIndex = (Camera.devIndex + 1) % Camera.devices.length;
  await Camera.startStream();
  const label = Camera.devices[Camera.devIndex].label;
  if (label) toast(label, 1600);
};
$('#cam-torch').onclick = async () => {
  const b = $('#cam-torch');
  const on = !b.classList.contains('on');
  try { await Camera.track.applyConstraints({ advanced: [{ torch: on }] }); b.classList.toggle('on', on); } catch (_) {}
};
$('#cam-zoom').oninput = (e) => {
  const v = Number(e.target.value);
  if (Camera.hwZoom) Camera.track && Camera.track.applyConstraints({ advanced: [{ zoom: v }] }).catch(() => {});
  else $('#cam-video').style.setProperty('--z', v);
};

/* --- manual crop for photos picked from the gallery --- */
const Cropper = { img: null, scale: 1, base: 1, x: 0, y: 0 };
$('#cam-file').onchange = async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  const img = $('#crop-img');
  img.src = URL.createObjectURL(file);
  await img.decode().catch(() => {});
  $('#cropper').hidden = false; // must be visible before measuring the stage
  const stage = $('#crop-stage').getBoundingClientRect();
  Cropper.base = Math.max(stage.width / img.naturalWidth, stage.height / img.naturalHeight);
  Cropper.scale = 1;
  $('#crop-zoom').value = 1;
  Cropper.x = (stage.width - img.naturalWidth * Cropper.base) / 2;
  Cropper.y = (stage.height - img.naturalHeight * Cropper.base) / 2;
  applyCrop();
};
function applyCrop() {
  const k = Cropper.base * Cropper.scale;
  $('#crop-img').style.transform = `translate(${Cropper.x}px, ${Cropper.y}px) scale(${k})`;
}
(() => {
  const stage = $('#crop-stage');
  let drag = null;
  stage.addEventListener('pointerdown', (e) => { drag = { x: e.clientX, y: e.clientY, ox: Cropper.x, oy: Cropper.y }; stage.setPointerCapture(e.pointerId); });
  stage.addEventListener('pointermove', (e) => {
    if (!drag) return;
    Cropper.x = drag.ox + (e.clientX - drag.x);
    Cropper.y = drag.oy + (e.clientY - drag.y);
    applyCrop();
  });
  stage.addEventListener('pointerup', () => (drag = null));
  stage.addEventListener('pointercancel', () => (drag = null));
  $('#crop-zoom').oninput = (e) => {
    const r = stage.getBoundingClientRect();
    const cx = r.width / 2, cy = r.height / 2;
    const k0 = Cropper.base * Cropper.scale;
    Cropper.scale = Number(e.target.value);
    const k1 = Cropper.base * Cropper.scale;
    // zoom around the centre of the ring
    Cropper.x = cx - ((cx - Cropper.x) * k1) / k0;
    Cropper.y = cy - ((cy - Cropper.y) * k1) / k0;
    applyCrop();
  };
})();
$('#crop-cancel').onclick = () => { $('#cropper').hidden = true; };
$('#crop-done').onclick = () => {
  const r = $('#crop-stage').getBoundingClientRect();
  const k = Cropper.base * Cropper.scale;
  const c = Camera.crop;
  c.width = c.height = SIZE;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, SIZE, SIZE);
  ctx.drawImage($('#crop-img'), -Cropper.x / k, -Cropper.y / k, r.width / k, r.height / k, 0, 0, SIZE, SIZE);
  $('#cropper').hidden = true;
  Camera.use();
};

/* ------------------------------------------------------------------ register */
let draft = null;

function resetRegister() {
  $('#reg-form').reset();
  $('#reg-photo-preview').hidden = true;
  $('#reg-photo-empty').hidden = false;
  draft = { id: uid(), photo: null, noses: [], features: [], canvases: [] };
}
$('#reg-photo').onchange = async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  draft.photo = await fileToPhotoBlob(f);
  const img = $('#reg-photo-preview');
  img.src = URL.createObjectURL(draft.photo);
  img.hidden = false;
  $('#reg-photo-empty').hidden = true;
};
$('#reg-form').onsubmit = (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  Object.assign(draft, Object.fromEntries([...fd.entries()].map(([k, v]) => [k, String(v).trim()])));
  draft.noses = []; draft.features = []; draft.canvases = [];
  $('#enroll-name').textContent = draft.name;
  renderEnroll('');
  show('enroll', 'replace');
};

function renderEnroll(msg, cls = '') {
  const slots = $('#enroll-slots');
  slots.innerHTML = '';
  for (let i = 0; i < 3; i++) {
    const s = document.createElement('div');
    s.className = 'nose-slot' + (draft.canvases[i] ? ' done' : '');
    if (draft.canvases[i]) {
      const img = document.createElement('img');
      img.src = draft.canvases[i].toDataURL('image/jpeg', 0.7);
      s.appendChild(img);
      const b = document.createElement('span');
      b.className = 'badge'; b.textContent = num(draft.features[i].n) + ' نقطة';
      s.appendChild(b);
    } else s.textContent = num(i + 1);
    slots.appendChild(s);
  }
  const n = draft.canvases.length;
  $('#enroll-capture').hidden = n >= 3;
  $('#enroll-capture-label').textContent = `تصوير الأنف ${num(n + 1)} من 3`;
  $('#enroll-save').hidden = n < 3;
  $('#enroll-save').className = 'btn primary block';
  const st = $('#enroll-status');
  st.textContent = msg; st.className = 'status ' + cls;
}

$('#enroll-capture').onclick = async () => {
  const d = draft; // keep this registration even if a new one starts meanwhile
  const n = d.canvases.length;
  const canvas = await Camera.open(`بصمة ${d.name} — صورة ${num(n + 1)} من 3`);
  if (!canvas) return;
  busy(Engine.ready ? 'جاري تحليل البصمة…' : 'جاري تحميل محرك التعرف…');
  await Engine.whenReady();
  busy('جاري تحليل البصمة…');
  try {
    const f = await Engine.extract(canvas);
    if (f.n < MIN_KP_ENROLL) {
      busy(null);
      return renderEnroll('الصورة لا تحتوي تفاصيل كافية من نسيج الأنف — اقترب أكثر أو حسّن الإضاءة ثم أعد التصوير.', 'bad');
    }
    if (n > 0) {
      // the new shot must agree with at least one earlier shot of the same nose
      let best = 0;
      for (const prev of d.features) {
        const r = await Engine.call('compare', { a: f, b: prev });
        best = Math.max(best, r.inliers);
      }
      if (best < 18) {
        busy(null);
        return renderEnroll('هذه الصورة لا تطابق الصور السابقة — تأكد أنه نفس الكلب وأن الأنف كاملاً داخل الدائرة، ثم أعد التصوير.', 'bad');
      }
    } else if (state.dogs.length) {
      const r = await Engine.call('identify', { query: f });
      if (r.decision.id) {
        const other = dogById(r.decision.id);
        busy(null);
        const go = confirm(`تنبيه: هذه البصمة تطابق الكلب المسجل «${other.name}».\n\nهل تريد المتابعة وتسجيله ككلب جديد؟`);
        if (!go) return renderEnroll(`البصمة مسجلة مسبقاً باسم «${other.name}».`, 'warn');
      }
    }
    d.canvases.push(canvas);
    d.features.push(f);
    busy(null);
    const left = 3 - d.canvases.length;
    renderEnroll(left ? `تم ✓ — ${num(f.n)} نقطة مميزة. باقي ${num(left)}.` : 'اكتملت البصمة ✓ اضغط «حفظ الكلب».', 'ok');
  } catch (err) {
    busy(null);
    renderEnroll('حدث خطأ أثناء التحليل: ' + err.message, 'bad');
  }
};

$('#enroll-save').onclick = async () => {
  const d = draft;
  if (dogById(d.id)) return;
  busy('جاري الحفظ…');
  const noses = [];
  for (const c of d.canvases) noses.push(await canvasToBlob(c, 0.9));
  const dog = {
    id: d.id, createdAt: Date.now(),
    name: d.name, breed: d.breed, sex: d.sex, age: d.age, color: d.color,
    father: d.father, mother: d.mother, owner: d.owner,
    vaccinated: d.vaccinated, vaccineDate: d.vaccineDate, notes: d.notes,
    photo: d.photo, noses, features: d.features,
  };
  await DB.put('dogs', dog);
  state.dogs.push(dog);
  await Engine.syncGallery();
  busy(null);
  toast(`تم تسجيل «${dog.name}» ✓`);
  history.replaceState({ name: 'dogs' }, '');
  openDog(dog.id);
};

/* ------------------------------------------------------------------ dogs */
function renderDogs() {
  const grid = $('#dog-grid');
  if (!state.dogs.length) {
    grid.innerHTML = '<div class="empty"><b>لا توجد كلاب مسجلة بعد</b>ابدأ بتسجيل أول كلب — الهدف 10 كلاب.</div>';
    return;
  }
  grid.innerHTML = state.dogs.map((d) => `
    <button class="dog-card" data-dog="${d.id}">
      <div class="ph">${d.photo ? `<img src="${blobUrl(d.photo)}" alt="">` : `<img src="${blobUrl(d.noses[0])}" alt="">`}</div>
      <div class="meta"><b>${esc(d.name)}</b><small>${esc(dogSubtitle(d))}</small></div>
    </button>`).join('');
  $$('[data-dog]', grid).forEach((b) => (b.onclick = () => openDog(b.dataset.dog)));
}

function profileHTML(d) {
  const vacc = d.vaccinated === 'yes' ? `مطعّم${d.vaccineDate ? ' — ' + esc(d.vaccineDate) : ''}` : d.vaccinated === 'no' ? 'غير مطعّم' : 'غير معروف';
  const fact = (label, val, wide, raw) => `<div class="fact${wide ? ' wide' : ''}"><span>${label}</span><b>${(raw ? val : esc(val)) || '—'}</b></div>`;
  return `
    <div class="profile">
      <div class="profile-head">
        <div class="avatar">${d.photo ? `<img src="${blobUrl(d.photo)}" alt="">` : `<img src="${blobUrl(d.noses[0])}" alt="">`}</div>
        <div><h2>${esc(d.name)}</h2><p>${esc(dogSubtitle(d))}</p><span class="id-chip">${shortId(d.id)}</span></div>
      </div>
      <div class="facts">
        ${fact('الأب', d.father)}${fact('الأم', d.mother)}
        ${fact('التطعيم', vacc, false, true)}${fact('اللون', d.color)}
        ${fact('المالك', d.owner, true)}
        ${d.notes ? fact('ملاحظات', d.notes, true) : ''}
      </div>
      <div class="nose-strip">${d.noses.map((b) => `<img src="${blobUrl(b)}" alt="">`).join('')}<span>بصمة الأنف · ${num(d.noses.length)} صور</span></div>
    </div>`;
}

function openDog(id) {
  const d = dogById(id);
  if (!d) return show('dogs');
  $('#dog-body').innerHTML = profileHTML(d) + `
    <button class="btn accent block" data-go="identify">تجربة التعرف على كلب</button>
    <button class="btn danger block" id="dog-del">حذف هذا الكلب</button>`;
  $('#dog-del').onclick = async () => {
    if (!confirm(`حذف «${d.name}» نهائياً من هذا الهاتف؟`)) return;
    await DB.del('dogs', d.id);
    state.dogs = state.dogs.filter((x) => x.id !== d.id);
    await Engine.syncGallery();
    toast('تم الحذف');
    history.back();
  };
  show('dog');
}

/* ------------------------------------------------------------------ identify */
let lastQuery = null;

async function startIdentify() {
  if (!state.dogs.length) {
    toast('سجّل كلباً واحداً على الأقل قبل التجربة');
    return show('register');
  }
  const canvas = await Camera.open('تعرّف — صوّر أنف الكلب');
  if (!canvas) return;
  const t0 = performance.now();
  busy(Engine.ready ? 'جاري البحث عن البصمة…' : 'جاري تحميل محرك التعرف…');
  await Engine.whenReady();
  busy('جاري البحث عن البصمة…');
  try {
    const f = await Engine.extract(canvas);
    if (f.n < MIN_KP_QUERY) {
      busy(null);
      lastQuery = { canvas, features: f, ms: 0, r: null, lowQuality: true };
      renderResult();
      show('result');
      return;
    }
    const r = await Engine.call('identify', { query: f });
    busy(null);
    lastQuery = { canvas, features: f, ms: Math.round(performance.now() - t0), r, at: Date.now() };
    renderResult();
    show('result');
  } catch (err) {
    busy(null);
    toast('حدث خطأ: ' + err.message);
  }
}

function renderResult() {
  const q = lastQuery, body = $('#result-body');
  if (q.lowQuality) {
    body.innerHTML = `
      <div class="verdict none"><span class="v-ico"><svg viewBox="0 0 24 24"><path d="M12 8v5M12 16.5v.5"/><circle cx="12" cy="12" r="9"/></svg></span>
      <div><h2>الصورة غير كافية</h2><p>لم يظهر نسيج الأنف بوضوح (${num(q.features.n)} نقطة فقط). اقترب أكثر وحسّن الإضاءة.</p></div></div>
      <button class="btn accent block" data-go="identify">إعادة التصوير</button>`;
    return;
  }
  const { r } = q;
  const top = r.ranked[0], second = r.ranked[1];
  const matched = r.decision.id ? dogById(r.decision.id) : null;
  let html = '';
  if (matched) {
    const st = strengthOf(top.score);
    html += `
      <div class="verdict ok"><span class="v-ico"><svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg></span>
      <div><h2>تم التعرف: ${esc(matched.name)}</h2><p>${st.label} · خلال ${(q.ms / 1000).toFixed(1)} ث</p></div></div>
      <div class="strength">
        <div class="strength-top"><span>قوة التطابق</span><b>${num(top.score)} نقطة متطابقة</b></div>
        <div class="meter"><span style="width:${Math.min(100, Math.round((top.score / 120) * 100))}%"></span></div>
        <div class="strength-top" style="margin-top:6px"><span>أقرب كلب آخر</span><span>${second ? `${esc(dogById(second.id)?.name)} — ${num(second.score)} نقطة` : '—'}</span></div>
      </div>
      ${profileHTML(matched)}`;
  } else {
    const near = top && top.score > 0 ? dogById(top.id) : null;
    html += `
      <div class="verdict none"><span class="v-ico"><svg viewBox="0 0 24 24"><path d="M12 8v5M12 16.5v.5"/><circle cx="12" cy="12" r="9"/></svg></span>
      <div><h2>${r.decision.ambiguous ? 'غير متأكد — أعد التصوير' : 'لم يتم التعرف على الكلب'}</h2>
      <p>${r.decision.ambiguous ? 'البصمة تشبه أكثر من كلب بدرجة متقاربة.' : 'إما أن الكلب غير مسجل، أو أن الصورة تحتاج إعادة.'}</p></div></div>
      <div class="strength">
        <div class="strength-top"><span>أقرب تطابق</span><b>${near ? `${esc(near.name)} — ${num(top.score)} نقطة` : 'لا يوجد'}</b></div>
        <div class="meter"><span style="width:${Math.min(100, Math.round(((top ? top.score : 0) / 120) * 100))}%"></span></div>
        <div class="strength-top" style="margin-top:6px"><span>الحد الأدنى للقبول</span><span>${num(r.accept)} نقطة</span></div>
      </div>
      <button class="btn accent block" data-go="identify" style="margin-bottom:14px">إعادة التصوير</button>`;
  }
  if (r.evidence && r.evidence.pairs.length && top.score >= 8) {
    html += `
      <div class="evidence">
        <h3>${matched ? 'دليل المطابقة' : 'أقرب مطابقة'}</h3>
        <p>كل خط يربط نقطة في الصورة الآن بنفس النقطة في صورة التسجيل.</p>
        <canvas id="ev-canvas" width="1024" height="512"></canvas>
        <div class="legend"><span>الصورة الآن</span><span>صورة التسجيل (${esc(dogById(r.evidence.dogId)?.name)})</span></div>
      </div>`;
  }
  html += feedbackHTML(matched);
  body.innerHTML = html;
  bindFeedback(matched);
  if ($('#ev-canvas')) drawEvidence($('#ev-canvas'), q.canvas, r.evidence);
}

async function drawEvidence(cv, queryCanvas, ev) {
  const ctx = cv.getContext('2d');
  const dog = dogById(ev.dogId);
  const tpl = await loadImage(blobUrl(dog.noses[ev.tpl]));
  // RTL page: "now" on the right, registered on the left
  ctx.drawImage(queryCanvas, 512, 0, 512, 512);
  ctx.drawImage(tpl, 0, 0, 512, 512);
  ctx.fillStyle = 'rgba(0,0,0,.15)'; ctx.fillRect(0, 0, 1024, 512);
  const p = ev.pairs;
  const count = p.length / 4;
  const step = Math.max(1, Math.floor(count / 70));
  ctx.lineWidth = 2;
  for (let i = 0; i < count; i += step) {
    const ax = p[4 * i] + 512, ay = p[4 * i + 1], bx = p[4 * i + 2], by = p[4 * i + 3];
    const hue = 160 + ((i * 37) % 60);
    ctx.strokeStyle = `hsla(${hue}, 85%, 60%, .75)`;
    ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
    ctx.fillStyle = '#ffd36b';
    ctx.beginPath(); ctx.arc(ax, ay, 3.5, 0, 7); ctx.fill();
    ctx.beginPath(); ctx.arc(bx, by, 3.5, 0, 7); ctx.fill();
  }
  ctx.fillStyle = 'rgba(255,255,255,.9)'; ctx.fillRect(510, 0, 4, 512);
}

function feedbackHTML(matched) {
  const others = state.dogs.filter((d) => !matched || d.id !== matched.id);
  const list = others.map((d) => `<button data-truth="${d.id}"><img src="${blobUrl(d.photo || d.noses[0])}" alt="">${esc(d.name)}</button>`).join('');
  return `
    <div class="feedback" id="feedback">
      <h3>تسجيل نتيجة الاختبار</h3>
      <p>${matched ? `هل هذا فعلاً «${esc(matched.name)}»؟` : 'هل هذا الكلب مسجل في التطبيق؟'}</p>
      <div class="row">
        ${matched
          ? `<button class="btn fb-yes" id="fb-yes">✓ نعم، صحيح</button><button class="btn fb-no" id="fb-no">✗ لا، خطأ</button>`
          : `<button class="btn fb-yes" id="fb-unreg">غير مسجل (صحيح)</button><button class="btn fb-no" id="fb-no">نعم مسجل</button>`}
      </div>
      <div class="pick-list" id="fb-pick" hidden>
        <p style="margin:6px 0 0">${matched ? 'من هو الكلب الحقيقي؟' : 'اختر الكلب:'}</p>
        ${list}
        ${matched ? '<button class="unreg" data-truth="__unreg">كلب غير مسجل</button>' : ''}
      </div>
    </div>`;
}

function bindFeedback(matched) {
  const save = (truthId) => saveAttempt(matched ? matched.id : null, truthId);
  if ($('#fb-yes') && matched) $('#fb-yes').onclick = () => save(matched.id);
  if ($('#fb-unreg')) $('#fb-unreg').onclick = () => save(null);
  $('#fb-no').onclick = () => { $('#fb-pick').hidden = false; $('#fb-pick').scrollIntoView({ behavior: 'smooth', block: 'center' }); };
  $$('[data-truth]').forEach((b) => (b.onclick = () => save(b.dataset.truth === '__unreg' ? null : b.dataset.truth)));
}

async function saveAttempt(predicted, truth) {
  const q = lastQuery;
  const top = q.r.ranked[0], second = q.r.ranked[1];
  const a = {
    id: uid(), at: q.at, ms: q.ms,
    predicted, predictedName: predicted ? dogById(predicted)?.name : null,
    truth, truthName: truth ? dogById(truth)?.name : null,
    topScore: top ? top.score : 0, topName: top ? dogById(top.id)?.name : null,
    secondScore: second ? second.score : 0, keypoints: q.features.n,
    gallerySize: state.dogs.length, device: navigator.userAgent.slice(0, 160),
  };
  await DB.put('attempts', a);
  state.attempts.unshift(a);
  const ok = predicted === truth;
  $('#feedback').outerHTML = `
    <div class="saved"><svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>تم حفظ النتيجة (${ok ? 'صحيحة' : 'خطأ'}) — المحاولة رقم ${num(state.attempts.length)}</div>
    <div class="row">
      <button class="btn accent" data-go="identify">تعرّف على كلب آخر</button>
      <button class="btn ghost" data-go="results">النتائج</button>
    </div>`;
}

/* ------------------------------------------------------------------ results */
function classify(a) {
  if (a.truth) {
    if (a.predicted === a.truth) return 'correct';
    if (a.predicted) return 'wrong';
    return 'missed';
  }
  return a.predicted ? 'falseAccept' : 'rejected';
}

function metrics() {
  const m = { total: state.attempts.length, regTotal: 0, correct: 0, wrong: 0, missed: 0, unregTotal: 0, rejected: 0, falseAccept: 0, avgMs: 0 };
  let ms = 0, msN = 0;
  for (const a of state.attempts) {
    const c = classify(a);
    m[c]++;
    if (a.truth) m.regTotal++; else m.unregTotal++;
    if (a.ms) { ms += a.ms; msN++; }
  }
  m.avgMs = msN ? ms / msN : 0;
  m.serious = m.wrong + m.falseAccept;
  return m;
}

function renderResults() {
  const m = metrics();
  const body = $('#results-body');
  if (!m.total) {
    body.innerHTML = `<div class="card"><h2 class="card-title">لا توجد محاولات بعد</h2>
      <p class="muted">بعد تسجيل الكلاب، استخدم «تعرّف» وصوّر أنف كلب، ثم أكّد إن كانت النتيجة صحيحة. ستظهر هنا الإحصائيات.</p>
      <button class="btn accent block" data-go="identify">ابدأ الاختبار</button></div>`;
    return;
  }
  const pct = (a, b) => (b ? num(Math.round((a / b) * 100)) + '%' : '—');
  const LABEL = {
    correct: ['ok', 'تعرّف صحيح'], wrong: ['bad', 'خلط بين كلبين'], missed: ['warn', 'لم يتعرف (إعادة تصوير)'],
    rejected: ['ok', 'غير مسجل — رُفض بشكل صحيح'], falseAccept: ['bad', 'غير مسجل لكنه أُعطي هوية'],
  };
  const rows = state.attempts.map((a) => {
    const [cls, label] = LABEL[classify(a)];
    const who = a.truthName || 'كلب غير مسجل';
    const said = a.predictedName ? `قال: ${esc(a.predictedName)}` : 'قال: غير معروف';
    const when = new Date(a.at).toLocaleString('ar-EG-u-nu-latn', { dateStyle: 'short', timeStyle: 'short' });
    return `<div class="log-row"><span class="dot ${cls}"></span><div class="txt"><b>${esc(who)}</b> — ${label}<br><small>${said} · ${num(a.topScore)} نقطة · ${when}</small></div></div>`;
  }).join('');
  body.innerHTML = `
    <div class="kpis">
      <div class="kpi hero-kpi"><b>${pct(m.correct, m.regTotal)}</b><span>دقة التعرف على الكلاب المسجلة</span><small>${num(m.correct)} صحيح من ${num(m.regTotal)} محاولة</small></div>
      <div class="kpi ${m.serious ? 'alert' : 'good'}"><b>${num(m.serious)}</b><span>أخطاء خطيرة</span><small>كلب أُعطي هوية كلب آخر — يجب أن تكون صفراً</small></div>
      <div class="kpi"><b>${pct(m.rejected, m.unregTotal)}</b><span>رفض الكلاب غير المسجلة</span><small>${num(m.rejected)} من ${num(m.unregTotal)}</small></div>
      <div class="kpi"><b>${num(m.missed)}</b><span>طلب إعادة تصوير</span><small>لم يتعرف على كلب مسجل</small></div>
      <div class="kpi"><b>${m.avgMs ? (m.avgMs / 1000).toFixed(1) : '—'}</b><span>ثانية لكل تعرف</span><small>${num(state.dogs.length)} كلاب مسجلة</small></div>
    </div>
    <button class="btn primary block" id="share-sum">مشاركة الملخص (واتساب)</button>
    <button class="btn ghost block" id="share-full">إرسال ملف النتائج الكامل</button>
    <div class="log" style="margin-top:14px"><h3>سجل المحاولات</h3>${rows}</div>
    <button class="btn danger block" id="clear-log">مسح سجل الاختبار</button>`;
  $('#share-sum').onclick = () => shareText(summaryText(m));
  $('#share-full').onclick = () => exportData(true);
  $('#clear-log').onclick = async () => {
    if (!confirm('مسح كل محاولات الاختبار؟ (الكلاب المسجلة لن تُحذف)')) return;
    await DB.clear('attempts');
    state.attempts = [];
    renderResults();
  };
}

function summaryText(m) {
  const pct = (a, b) => (b ? Math.round((a / b) * 100) + '%' : '—');
  return [
    'EGY ANIMAL ID — نتيجة تجربة بصمة الأنف',
    `الكلاب المسجلة: ${state.dogs.length}`,
    `محاولات التعرف: ${m.total}`,
    `دقة التعرف على المسجلين: ${pct(m.correct, m.regTotal)} (${m.correct}/${m.regTotal})`,
    `رفض غير المسجلين: ${pct(m.rejected, m.unregTotal)} (${m.rejected}/${m.unregTotal})`,
    `أخطاء خطيرة (خلط هوية): ${m.serious}`,
    `طلب إعادة تصوير: ${m.missed}`,
    `متوسط الزمن: ${m.avgMs ? (m.avgMs / 1000).toFixed(1) + ' ث' : '—'}`,
  ].join('\n');
}

async function shareText(text) {
  try {
    if (navigator.share) { await navigator.share({ text }); return; }
  } catch (err) { if (err.name === 'AbortError') return; }
  try { await navigator.clipboard.writeText(text); toast('تم نسخ الملخص — الصقه في واتساب'); }
  catch (_) { location.href = 'https://wa.me/?text=' + encodeURIComponent(text); }
}

/* ------------------------------------------------------------------ export / import */
function blobToDataURL(b) {
  return new Promise((r) => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(b); });
}
async function buildExport(withAttempts) {
  const dogs = [];
  for (const d of state.dogs) {
    const { photo, noses, features, ...profile } = d;
    dogs.push({ ...profile, photo: photo ? await blobToDataURL(photo) : null, noses: await Promise.all(noses.map(blobToDataURL)) });
  }
  const data = { app: 'egy-animal-id-poc', version: 1, exportedAt: new Date().toISOString(), dogs, attempts: withAttempts ? state.attempts : [] };
  const stamp = new Date().toISOString().slice(0, 10);
  const name = withAttempts ? `nose-test-results-${stamp}.json` : `nose-dogs-${stamp}.json`;
  return new File([JSON.stringify(data)], name, { type: 'application/json' });
}
async function exportData(withAttempts) {
  busy('جاري تجهيز الملف…');
  const file = await buildExport(withAttempts);
  const name = file.name;
  busy(null);
  try {
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title: name });
      return;
    }
  } catch (err) { if (err.name === 'AbortError') return; }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
$('#btn-export').onclick = () => (state.dogs.length ? exportData(false) : toast('لا توجد كلاب للتصدير'));

$('#import-file').onchange = async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  let data;
  try { data = JSON.parse(await file.text()); } catch (_) { return toast('الملف غير صالح'); }
  if (data.app !== 'egy-animal-id-poc' || !Array.isArray(data.dogs)) return toast('هذا ليس ملف بيانات التطبيق');
  await Engine.whenReady();
  let added = 0;
  for (let i = 0; i < data.dogs.length; i++) {
    const src = data.dogs[i];
    if (dogById(src.id)) continue;
    busy(`جاري الاستيراد ${num(i + 1)} من ${num(data.dogs.length)}…`);
    const noses = [], features = [];
    for (const url of src.noses) {
      const blob = await (await fetch(url)).blob();
      const img = await loadImage(URL.createObjectURL(blob));
      const c = document.createElement('canvas'); c.width = c.height = SIZE;
      c.getContext('2d').drawImage(img, 0, 0, SIZE, SIZE);
      noses.push(blob);
      features.push(await Engine.extract(c));
    }
    const photo = src.photo ? await (await fetch(src.photo)).blob() : null;
    const dog = { ...src, photo, noses, features };
    await DB.put('dogs', dog);
    state.dogs.push(dog);
    added++;
  }
  await Engine.syncGallery();
  busy(null);
  toast(added ? `تم استيراد ${num(added)} كلب ✓` : 'كل الكلاب موجودة مسبقاً');
  renderDogs();
};

/* ------------------------------------------------------------------ boot */
(async function boot() {
  history.replaceState({ name: 'home' }, '');
  Engine.start();
  try {
    await DB.open();
    await loadData();
  } catch (err) {
    toast('تعذر فتح التخزين على هذا المتصفح: ' + err.message, 6000);
  }
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  if (state.dogs.length) Engine.syncGallery();
  renderHome();
  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
})();
