// Storage. Settings, the queue and the conversation go in app storage; tokens and API keys go in the iPhone Keychain.
// In a desktop browser (development only) secrets fall back to session storage, which is cleared when the tab closes.
import { Capacitor } from '@capacitor/core';
import { Preferences } from '@capacitor/preferences';
import { SecureStorage } from '@aparajita/capacitor-secure-storage';

const native = Capacitor.isNativePlatform();

export const kv = {
  async get(k, d = null) {
    try {
      if (native) { const { value } = await Preferences.get({ key: k }); return value == null ? d : JSON.parse(value); }
      const v = localStorage.getItem('hq.' + k); return v == null ? d : JSON.parse(v);
    } catch (e) { return d; }
  },
  async set(k, v) {
    try {
      if (native) await Preferences.set({ key: k, value: JSON.stringify(v) });
      else localStorage.setItem('hq.' + k, JSON.stringify(v));
    } catch (e) { /* storage full or unavailable: keep running */ }
  },
};

export const secrets = {
  async get(k) {
    try {
      if (native) { const v = await SecureStorage.get(k); return v == null ? null : String(v); }
      return sessionStorage.getItem('hq.s.' + k);
    } catch (e) { return null; }
  },
  async set(k, v) {
    try {
      if (native) { if (v == null || v === '') await SecureStorage.remove(k); else await SecureStorage.set(k, String(v)); }
      else if (v == null || v === '') sessionStorage.removeItem('hq.s.' + k); else sessionStorage.setItem('hq.s.' + k, String(v));
    } catch (e) { /* keychain unavailable */ }
  },
};
