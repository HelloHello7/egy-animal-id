# EGY Animal ID — Nose-print proof of concept

نموذج تجريبي يتحقق من إمكانية التعرف على الكلاب ببصمة الأنف عبر كاميرا الهاتف، قبل بناء التطبيق الكامل.

A mobile web app (PWA) to test whether a phone camera can identify individual dogs by their nose print.

- Register a dog: profile (name, breed, sire, dam, vaccination…) + 3 nose photos.
- Identify: one nose photo → matched profile, match strength and visual evidence, or "not registered".
- Test log: confirm each result (✓/✗) to measure accuracy, unregistered-dog rejection and serious errors.
- Everything runs on the phone (OpenCV.js in a Web Worker); data stays in the browser (IndexedDB). Export/import moves the registry to a second phone.

Matching: CLAHE-enhanced 512×512 nose crop → AKAZE keypoints → Hamming kNN + ratio test → RANSAC homography; the inlier count is the score (accept ≥ 18 and 1.6× the runner-up).

This is a proof of concept, not a production biometric system.
