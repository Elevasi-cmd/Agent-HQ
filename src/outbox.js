// Commands waiting to reach the desktop. Each has a fixed id from the moment it is created. The bridge writes an id
// down before it acts on it, so a resend after a dropped connection gets the first result, "still running" or
// "uncertain" — it is not run again. That holds while the bridge's record exists (14 days); it is not a promise of
// exactly-once delivery. States:
//   queued -> sending -> done | failed
//   unknown:   sent, answer lost; asked about (never resent blindly) when the desktop is back
//   uncertain: the desktop started it but can't say whether it finished. Only you can decide to send it again.

export function newId() {
  if (globalThis.crypto && crypto.randomUUID) return 'c-' + crypto.randomUUID();
  return 'c-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 12);
}

// store: { load(): Promise<array|null>, save(array): Promise }
export const MAX_AGE = 12 * 864e5; // older unanswered commands may have outlived the bridge's record of them

export function createOutbox(store, { keepDone = 40, now = () => Date.now() } = {}) {
  let items = [], loaded = false, flushing = null;
  const save = () => store.save(items);
  return {
    async load() {
      items = (await store.load()) || [];
      // anything caught mid-send when the app was suspended goes back in the queue; resending is safe
      // its answer was lost either way; ask the bridge what happened rather than assuming
      items.forEach(i => { if (i.state === 'sending') i.state = 'unknown'; });
      loaded = true; return items;
    },
    get items() { return items; },
    queued() { return items.filter(i => i.state === 'queued'); },
    async add(type, payload, label, opts = {}) {
      const it = { id: newId(), type, payload, label: label || type, state: 'queued', tries: 0, at: now(), result: null, noResend: !!opts.noResend };
      items.push(it); await save(); return it;
    },
    // send(item) -> Promise<{ ok, duplicate?, gone?, error? }>, throws on network failure
    flush(send) {
      if (flushing) return flushing;
      flushing = (async () => {
        let sent = 0;
        for (const it of items) {
          if (it.state !== 'queued') continue;
          if (it.tries > 0 && now() - it.at > MAX_AGE) { it.state = 'uncertain'; it.result = { error: 'Too old to check safely. Look on the desktop before sending it again.' }; await save(); continue; }
          it.state = 'sending'; it.tries++; await save();
          let r;
          // an approval whose delivery is uncertain is never resent blindly: it becomes 'unknown' and is checked instead
          try { r = await send(it); } catch (e) { it.state = it.noResend ? 'unknown' : 'queued'; await save(); break; }
          if (r && r.inProgress) { it.state = 'unknown'; it.result = null; }
          else if (r && r.uncertain) { it.state = 'uncertain'; it.result = r; }
          else if (r && (r.ok || r.duplicate)) { it.state = 'done'; it.result = r; sent++; }
          else if (r && r.gone) { it.state = 'failed'; it.result = r; }
          else { it.state = 'failed'; it.result = r || { error: 'no answer' }; }
          await save();
        }
        const done = items.filter(i => i.state === 'done' || i.state === 'failed' || i.state === 'uncertain');
        if (done.length > keepDone) { const drop = new Set(done.slice(0, done.length - keepDone).map(i => i.id)); items = items.filter(i => !drop.has(i.id)); await save(); }
        return sent;
      })().finally(() => { flushing = null; });
      return flushing;
    },
    // check() -> Promise<{ known, state?, result? }> from the bridge, for items whose answer was lost
    async resolveUnknown(check) {
      for (const it of items.filter(i => i.state === 'unknown')) {
        let r; try { r = await check(it); } catch (e) { return; }
        if (r.known && r.state === 'in-progress') continue; // still running there; ask again next time
        if (r.known && r.state === 'uncertain') { it.state = 'uncertain'; it.result = { error: 'Started on the desktop, but it can\'t say whether it finished. Check there before sending again.' }; }
        else if (r.known) { it.state = r.result && r.result.ok ? 'done' : 'failed'; it.result = r.result; }
        else if (it.noResend) { it.state = 'failed'; it.result = { error: 'Not delivered. If it is still waiting, decide again.' }; }
        // the bridge records an id before acting on it, so "not known" means it never started: safe to send with the same id
        else if (now() - it.at <= MAX_AGE) { it.state = 'queued'; }
        else { it.state = 'uncertain'; it.result = { error: 'Too old to check safely. Look on the desktop before sending it again.' }; }
        await save();
      }
    },
    // Sending again after a failure or an uncertain outcome is your explicit choice, so it goes as a NEW command
    // (new id): the bridge would otherwise answer with the first outcome. Approvals are never sent again.
    async resend(id) {
      const it = items.find(i => i.id === id);
      if (!it || it.noResend || !['failed', 'uncertain'].includes(it.state)) return null;
      items = items.filter(i => i !== it);
      const copy = { id: newId(), type: it.type, payload: it.payload, label: it.label, state: 'queued', tries: 0, at: now(), result: null, noResend: false, resentFrom: it.id };
      items.push(copy); await save(); return copy;
    },
    async remove(id) { items = items.filter(i => i.id !== id); await save(); },
  };
}
