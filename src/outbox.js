// Commands waiting to reach the desktop. Each has a fixed id from the moment it is created, so resending after a
// dropped connection or an app suspension can never run it twice: the bridge answers a repeat with the first result.

export function newId() {
  if (globalThis.crypto && crypto.randomUUID) return 'c-' + crypto.randomUUID();
  return 'c-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 12);
}

// store: { load(): Promise<array|null>, save(array): Promise }
export function createOutbox(store, { keepDone = 40 } = {}) {
  let items = [], loaded = false, flushing = null;
  const save = () => store.save(items);
  return {
    async load() {
      items = (await store.load()) || [];
      // anything caught mid-send when the app was suspended goes back in the queue; resending is safe
      items.forEach(i => { if (i.state === 'sending') i.state = i.noResend ? 'unknown' : 'queued'; });
      loaded = true; return items;
    },
    get items() { return items; },
    queued() { return items.filter(i => i.state === 'queued'); },
    async add(type, payload, label, opts = {}) {
      const it = { id: newId(), type, payload, label: label || type, state: 'queued', tries: 0, at: Date.now(), result: null, noResend: !!opts.noResend };
      items.push(it); await save(); return it;
    },
    // send(item) -> Promise<{ ok, duplicate?, gone?, error? }>, throws on network failure
    flush(send) {
      if (flushing) return flushing;
      flushing = (async () => {
        let sent = 0;
        for (const it of items) {
          if (it.state !== 'queued') continue;
          it.state = 'sending'; it.tries++; await save();
          let r;
          // an approval whose delivery is uncertain is never resent blindly: it becomes 'unknown' and is checked instead
          try { r = await send(it); } catch (e) { it.state = it.noResend ? 'unknown' : 'queued'; await save(); break; }
          if (r && (r.ok || r.duplicate)) { it.state = 'done'; it.result = r; sent++; }
          else if (r && r.gone) { it.state = 'failed'; it.result = r; }
          else { it.state = 'failed'; it.result = r || { error: 'no answer' }; }
          await save();
        }
        const done = items.filter(i => i.state === 'done' || i.state === 'failed');
        if (done.length > keepDone) { const drop = new Set(done.slice(0, done.length - keepDone).map(i => i.id)); items = items.filter(i => !drop.has(i.id)); await save(); }
        return sent;
      })().finally(() => { flushing = null; });
      return flushing;
    },
    // check() -> Promise<{ known, result }>, for items whose outcome is unknown
    async resolveUnknown(check) {
      for (const it of items.filter(i => i.state === 'unknown')) {
        let r; try { r = await check(it); } catch (e) { return; }
        if (r.known) { it.state = r.result && r.result.ok ? 'done' : 'failed'; it.result = r.result; }
        else { it.state = 'failed'; it.result = { error: 'Not delivered. If it is still waiting, decide again.' }; }
        await save();
      }
    },
    async retry(id) { const it = items.find(i => i.id === id); if (it && it.state === 'failed') { it.state = 'queued'; await save(); } },
    async remove(id) { items = items.filter(i => i.id !== id); await save(); },
  };
}
