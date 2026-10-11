/*
 * Recognition worker: loads OpenCV.js once, keeps the gallery in memory,
 * and answers extract / compare / identify requests from the page.
 */
importScripts('nosematch.js');

const OPENCV_URL = 'opencv.js';
const OPENCV_BYTES = 10872779; // uncompressed size, used for the progress bar
let cv = null;
let gallery = [];
const queue = [];

function post(msg, transfer) { self.postMessage(msg, transfer || []); }

async function boot() {
  try {
    const res = await fetch(OPENCV_URL);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const reader = res.body.getReader();
    const chunks = [];
    let got = 0, lastPct = -1;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      got += value.length;
      const pct = Math.min(95, Math.round((got / OPENCV_BYTES) * 95));
      if (pct !== lastPct) { lastPct = pct; post({ type: 'progress', pct }); }
    }
    const url = URL.createObjectURL(new Blob(chunks, { type: 'text/javascript' }));
    try {
      importScripts(url);
    } catch (_) {
      // some older browsers refuse blob: URLs here; the file is now in the HTTP/SW cache
      importScripts(OPENCV_URL);
    }
    URL.revokeObjectURL(url);
    await runtimeReady(self.cv);
    post({ type: 'progress', pct: 100 });
    post({ type: 'ready' });
    while (queue.length) handle(queue.shift());
  } catch (err) {
    post({ type: 'fatal', message: String(err && err.message || err) });
  }
}

function runtimeReady(mod) {
  return new Promise((resolve) => {
    const done = () => { cv = mod; resolve(); };
    if (mod.Mat) return done();
    mod.onRuntimeInitialized = done;
    // fallback in case initialisation finished between the checks
    const t = setInterval(() => { if (mod.Mat) { clearInterval(t); done(); } }, 100);
  });
}

function grayMat(gray) {
  return cv.matFromArray(NoseMatch.SIZE, NoseMatch.SIZE, cv.CV_8UC1, gray);
}

function handle(msg) {
  const { id, type } = msg;
  try {
    if (type === 'extract') {
      const m = grayMat(msg.gray);
      const f = NoseMatch.extract(cv, m);
      m.delete();
      post({ id, ok: true, features: f }, [f.pts.buffer, f.desc.buffer]);
    } else if (type === 'setGallery') {
      gallery = msg.gallery;
      post({ id, ok: true });
    } else if (type === 'compare') {
      const r = NoseMatch.match(cv, msg.a, msg.b, false);
      post({ id, ok: true, inliers: r.inliers });
    } else if (type === 'identify') {
      const pool = msg.exclude ? gallery.filter((g) => g.id !== msg.exclude) : gallery;
      const ranked = NoseMatch.rank(cv, msg.query, pool);
      const decision = NoseMatch.decide(ranked);
      let evidence = null;
      const top = ranked[0];
      if (top && top.tpl >= 0) {
        const dog = pool.find((g) => g.id === top.id);
        const r = NoseMatch.match(cv, msg.query, dog.templates[top.tpl], true);
        evidence = { dogId: top.id, tpl: top.tpl, pairs: r.pairs };
      }
      post({ id, ok: true, ranked, decision: { id: decision.id, ambiguous: !!decision.ambiguous }, evidence,
        accept: NoseMatch.ACCEPT });
    }
  } catch (err) {
    post({ id, ok: false, message: String(err && err.message || err) });
  }
}

self.onmessage = (e) => {
  if (!cv) queue.push(e.data);
  else handle(e.data);
};

boot();
