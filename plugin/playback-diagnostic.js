// Temporary observation only: never reads media URLs or changes playback/output.
export function createPlaybackDiagnostic(document, send) {
  const documents = new Set(), slots = new WeakMap();
  let nextSlot = 0, sequence = 0, closed = false;
  const triggers = ['error', 'stalled', 'waiting', 'emptied'];
  const onEvent = event => {
    if (['AUDIO', 'VIDEO'].includes(event.target?.tagName)) sample(event.type);
  };
  function sample(trigger = 'poll') {
    if (closed) return;
    try {
      const seen = new Set(), elements = new Set();
      let blockedFrames = 0;
      const walk = (doc, depth) => {
        if (seen.has(doc) || seen.size >= 8) return;
        seen.add(doc);
        if (!documents.has(doc)) {
          for (const type of triggers) doc.addEventListener(type, onEvent, true);
          documents.add(doc);
        }
        for (const element of doc.querySelectorAll('audio,video')) if (elements.size < 64) elements.add(element);
        if (depth >= 2) return;
        for (const frame of [...doc.querySelectorAll('iframe')].slice(0, 8)) {
          try { const child = frame.contentDocument; if (child) walk(child, depth + 1); else blockedFrames++; }
          catch { blockedFrames++; }
        }
      };
      walk(document, 0);
      for (const doc of documents) if (!seen.has(doc)) {
        for (const type of triggers) doc.removeEventListener(type, onEvent, true);
        documents.delete(doc);
      }
      const priority = element => element.error ? 2 : !element.paused ? 1 : 0;
      const media = [...elements].sort((a, b) => priority(b) - priority(a)).slice(0, 4).map(element => {
        if (!slots.has(element)) slots.set(element, ++nextSlot);
        const currentTime = element.currentTime;
        return { slot: slots.get(element), currentTime: Number.isFinite(currentTime) ? currentTime : null,
          paused: element.paused, ended: element.ended, seeking: element.seeking,
          readyState: element.readyState, networkState: element.networkState, errorCode: element.error?.code ?? 0 };
      });
      Promise.resolve(send({ sequence: ++sequence, trigger, hidden: document.hidden === true, blockedFrames, mediaCount: elements.size, media })).catch(() => {});
    } catch { /* A diagnostic failure must never affect the player. */ }
  }
  return { sample, close() {
    closed = true;
    for (const doc of documents) for (const type of triggers) doc.removeEventListener(type, onEvent, true);
    documents.clear();
  } };
}
