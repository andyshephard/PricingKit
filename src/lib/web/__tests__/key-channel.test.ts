import { describe, it, expect, vi, afterEach } from 'vitest';
import { connectKeyChannel, openKeyChannel, type KeyChannel } from '../key-channel';

/** Two tabs: what one posts, the other receives */
function pair(): [KeyChannel, KeyChannel] {
  const a: KeyChannel = { onmessage: null, postMessage: (data) => b.onmessage?.({ data } as MessageEvent) };
  const b: KeyChannel = { onmessage: null, postMessage: (data) => a.onmessage?.({ data } as MessageEvent) };
  return [a, b];
}

function handlers() {
  return { dropCached: vi.fn(), signedOut: vi.fn() };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('key channel between tabs', () => {
  it('a forget signs the other tab out of that store', () => {
    const [a, b] = pair();
    const tabA = connectKeyChannel(a, handlers());
    const other = handlers();
    connectKeyChannel(b, other);
    tabA({ type: 'forgot', platform: 'google' });
    expect(other.dropCached).toHaveBeenCalledWith('google');
    expect(other.signedOut).toHaveBeenCalledWith('google');
  });

  it('sign-out (forgetAll) drops both stores and signs the other tab out', () => {
    const [a, b] = pair();
    const tabA = connectKeyChannel(a, handlers());
    const other = handlers();
    connectKeyChannel(b, other);
    tabA({ type: 'forgotAll' });
    expect(other.dropCached.mock.calls).toEqual([['apple'], ['google']]);
    expect(other.signedOut).toHaveBeenCalledWith('all');
  });

  it('a save only drops the cached key, so the new one is read', () => {
    const [a, b] = pair();
    const tabA = connectKeyChannel(a, handlers());
    const other = handlers();
    connectKeyChannel(b, other);
    tabA({ type: 'saved', platform: 'apple' });
    expect(other.dropCached).toHaveBeenCalledWith('apple');
    expect(other.signedOut).not.toHaveBeenCalled();
  });

  it('ignores malformed messages', () => {
    const [, b] = pair();
    const other = handlers();
    connectKeyChannel(b, other);
    for (const data of [null, 'x', { type: 'forgot', platform: 'steam' }, { type: 'nuke' }]) b.onmessage?.({ data } as MessageEvent);
    expect(other.dropCached).not.toHaveBeenCalled();
    expect(other.signedOut).not.toHaveBeenCalled();
  });

  it('works without BroadcastChannel: changes stay local', () => {
    vi.stubGlobal('BroadcastChannel', undefined);
    expect(openKeyChannel()).toBeNull();
    const notify = connectKeyChannel(null, handlers());
    expect(() => notify({ type: 'forgotAll' })).not.toThrow();
  });
});
