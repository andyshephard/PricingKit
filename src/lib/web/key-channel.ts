// Keeps every tab of this site in step with the key store: a key saved,
// forgotten or signed out in one tab is noticed by the others, which drop
// their cached key and tokens. A forget or sign-out also signs the other tabs
// out. Messages carry the change and platform only, never key material.

import type { KeyChangeEvent, KeyPlatform } from '@/lib/browser-keys';

export const KEY_CHANNEL_NAME = 'pricingkit-keys';

/** The parts of BroadcastChannel used here */
export interface KeyChannel {
  postMessage(message: unknown): void;
  onmessage: ((event: MessageEvent) => void) | null;
}

export interface KeyChannelHandlers {
  dropCached: (platform: KeyPlatform) => void;
  /** Another tab forgot this platform's key (or signed out): clear this tab's state and leave the app */
  signedOut: (platform: KeyPlatform | 'all') => void;
}

const PLATFORMS: readonly KeyPlatform[] = ['apple', 'google'];

function parse(data: unknown): KeyChangeEvent | null {
  if (typeof data !== 'object' || data === null) return null;
  const { type, platform } = data as { type?: unknown; platform?: unknown };
  if (type === 'forgotAll') return { type };
  if ((type === 'saved' || type === 'forgot') && PLATFORMS.includes(platform as KeyPlatform)) return { type, platform: platform as KeyPlatform };
  return null;
}

/** A BroadcastChannel, or null where there is none (old browsers, server rendering, tests) */
export function openKeyChannel(): KeyChannel | null {
  try {
    return typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(KEY_CHANNEL_NAME);
  } catch {
    return null;
  }
}

/**
 * Listens on the channel and returns the function to pass as BrowserKeys'
 * onChange, which tells the other tabs. Without a channel, changes stay local.
 */
export function connectKeyChannel(channel: KeyChannel | null, handlers: KeyChannelHandlers): (event: KeyChangeEvent) => void {
  if (!channel) return () => {};
  channel.onmessage = (message) => {
    const event = parse(message.data);
    if (!event) return;
    if (event.type === 'forgotAll') {
      for (const platform of PLATFORMS) handlers.dropCached(platform);
      handlers.signedOut('all');
      return;
    }
    handlers.dropCached(event.platform);
    if (event.type === 'forgot') handlers.signedOut(event.platform);
  };
  return (event) => {
    try {
      channel.postMessage(event.type === 'forgotAll' ? { type: event.type } : { type: event.type, platform: event.platform });
    } catch {
      // the channel was closed; other tabs notice on their next store refusal
    }
  };
}
