'use client';

import { useEffect } from 'react';
import { FLOOR_SCREENS } from '@dayson/domain';

/** Pages cached for offline use as soon as the worker is active. */
export const FLOOR_SHELL_URLS = ['/floor', '/floor/outbox', '/floor/dealer', ...FLOOR_SCREENS.map((s) => `/floor/${s}`)];

/**
 * Registers the service worker with scope /floor only, so the back office is
 * never served from a cache. Production builds only: in development the
 * worker would hide code changes.
 */
export function ServiceWorkerRegister() {
  useEffect(() => {
    if (process.env.NODE_ENV !== 'production') return;
    if (!('serviceWorker' in navigator)) return;
    let cancelled = false;
    void (async () => {
      try {
        const registration = await navigator.serviceWorker.register('/sw.js', { scope: '/floor' });
        await navigator.serviceWorker.ready;
        if (cancelled) return;
        const worker = registration.active ?? navigator.serviceWorker.controller;
        worker?.postMessage({ type: 'WARM', urls: FLOOR_SHELL_URLS });
      } catch (err) {
        console.warn('service worker registration failed', err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  return null;
}
