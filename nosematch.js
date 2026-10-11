/*
 * NoseMatch — dog nose-print features and matching on top of OpenCV.js.
 * Works in a Web Worker (importScripts) and in Node (require) for testing.
 *
 * Pipeline: 512x512 nose crop -> CLAHE -> mask glare + outside circle
 *           -> AKAZE keypoints/descriptors -> Hamming kNN + ratio test
 *           -> RANSAC homography -> inlier count = similarity score.
 */
(function (root) {
  'use strict';

  const SIZE = 512;          // every nose crop is normalised to SIZE x SIZE
  const MAX_KP = 1200;       // strongest keypoints kept per image
  const RATIO = 0.8;         // Lowe ratio test
  const REPROJ = 7.0;        // RANSAC reprojection threshold in pixels

  // Builds the enhanced image and the detection mask (glare and corners excluded).
  function prepare(cv, gray) {
    const enhanced = new cv.Mat();
    const clahe = new cv.CLAHE(2.5, new cv.Size(8, 8));
    clahe.apply(gray, enhanced);
    clahe.delete();

    const glare = new cv.Mat();
    cv.threshold(gray, glare, 235, 255, cv.THRESH_BINARY);
    const kernel = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(9, 9));
    cv.dilate(glare, glare, kernel);
    kernel.delete();

    const mask = new cv.Mat(SIZE, SIZE, cv.CV_8UC1, new cv.Scalar(0));
    cv.circle(mask, new cv.Point(SIZE / 2, SIZE / 2), Math.round(SIZE * 0.48), new cv.Scalar(255), -1);
    cv.bitwise_not(glare, glare);
    cv.bitwise_and(mask, glare, mask);
    glare.delete();
    return { enhanced, mask };
  }

  // Returns plain typed arrays so features can be stored in IndexedDB.
  function extract(cv, gray) {
    const { enhanced, mask } = prepare(cv, gray);
    const akaze = new cv.AKAZE();
    if (akaze.setThreshold) akaze.setThreshold(0.0006);
    const kps = new cv.KeyPointVector();
    const desc = new cv.Mat();
    akaze.detectAndCompute(enhanced, mask, kps, desc);

    const n = kps.size();
    const cols = desc.cols;
    const order = [];
    for (let i = 0; i < n; i++) order.push([kps.get(i).response, i]);
    order.sort((a, b) => b[0] - a[0]);
    const keep = order.slice(0, MAX_KP).map((o) => o[1]);

    const pts = new Float32Array(keep.length * 2);
    const out = new Uint8Array(keep.length * cols);
    keep.forEach((idx, j) => {
      const kp = kps.get(idx);
      pts[2 * j] = kp.pt.x;
      pts[2 * j + 1] = kp.pt.y;
      out.set(desc.data.subarray(idx * cols, (idx + 1) * cols), j * cols);
    });

    akaze.delete(); kps.delete(); desc.delete(); enhanced.delete(); mask.delete();
    return { n: keep.length, cols, pts, desc: out };
  }

  function descMat(cv, f) {
    return cv.matFromArray(f.n, f.cols, cv.CV_8U, f.desc);
  }

  // Similarity between two feature sets: number of geometrically consistent matches.
  // With detail=true also returns the inlier point pairs [ax, ay, bx, by, ...].
  function match(cv, a, b, detail) {
    if (a.n < 8 || b.n < 8) return { inliers: 0, good: 0 };
    const da = descMat(cv, a), db = descMat(cv, b);
    const bf = new cv.BFMatcher(cv.NORM_HAMMING, false);
    const knn = new cv.DMatchVectorVector();
    bf.knnMatch(da, db, knn, 2);

    // ratio test, then keep one match per train keypoint (the closest)
    const best = new Map();
    for (let i = 0; i < knn.size(); i++) {
      const m = knn.get(i);
      if (m.size() < 2) continue;
      const m0 = m.get(0), m1 = m.get(1);
      if (m0.distance < RATIO * m1.distance) {
        const prev = best.get(m0.trainIdx);
        if (!prev || m0.distance < prev.distance) best.set(m0.trainIdx, m0);
      }
    }
    knn.delete(); bf.delete(); da.delete(); db.delete();

    const good = [...best.values()];
    if (good.length < 8) return { inliers: 0, good: good.length };

    const src = new Float32Array(good.length * 2), dst = new Float32Array(good.length * 2);
    good.forEach((m, i) => {
      src[2 * i] = a.pts[2 * m.queryIdx]; src[2 * i + 1] = a.pts[2 * m.queryIdx + 1];
      dst[2 * i] = b.pts[2 * m.trainIdx]; dst[2 * i + 1] = b.pts[2 * m.trainIdx + 1];
    });
    const sm = cv.matFromArray(good.length, 1, cv.CV_32FC2, src);
    const dm = cv.matFromArray(good.length, 1, cv.CV_32FC2, dst);
    const inlierMask = new cv.Mat();
    const H = cv.findHomography(sm, dm, cv.RANSAC, REPROJ, inlierMask, 2000, 0.995);

    let inliers = 0;
    const pairs = [];
    if (!H.empty() && plausible(H)) {
      for (let i = 0; i < inlierMask.rows; i++) {
        if (!inlierMask.data[i]) continue;
        inliers++;
        if (detail) pairs.push(src[2 * i], src[2 * i + 1], dst[2 * i], dst[2 * i + 1]);
      }
    }
    sm.delete(); dm.delete(); inlierMask.delete(); H.delete();
    return detail ? { inliers, good: good.length, pairs } : { inliers, good: good.length };
  }

  // Rejects degenerate homographies (mirrored, collapsed or wildly scaled).
  function plausible(H) {
    const h = H.data64F;
    const det = h[0] * h[4] - h[1] * h[3];
    if (!(det > 0.25 && det < 4)) return false;
    if (Math.abs(h[6]) > 0.002 || Math.abs(h[7]) > 0.002) return false;
    return true;
  }

  // gallery: [{ id, templates: [features, ...] }] -> ranked [{ id, score, tpl }]
  // score = best inlier count over the dog's templates, tpl = index of that template.
  function rank(cv, query, gallery) {
    return gallery
      .map((dog) => {
        let score = 0, tpl = -1;
        dog.templates.forEach((t, i) => {
          const s = match(cv, query, t).inliers;
          if (s > score) { score = s; tpl = i; }
        });
        return { id: dog.id, score, tpl };
      })
      .sort((x, y) => y.score - x.score);
  }

  // Decision rule: strong enough and clearly ahead of the runner-up.
  const ACCEPT = 18;
  const MARGIN = 1.6;
  function decide(ranked) {
    const top = ranked[0], second = ranked[1];
    if (!top || top.score < ACCEPT) return { id: null, top, second };
    if (second && top.score < MARGIN * Math.max(second.score, 1)) return { id: null, top, second, ambiguous: true };
    return { id: top.id, top, second };
  }

  const api = { SIZE, extract, match, rank, decide, ACCEPT, MARGIN };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.NoseMatch = api;
})(typeof self !== 'undefined' ? self : this);
