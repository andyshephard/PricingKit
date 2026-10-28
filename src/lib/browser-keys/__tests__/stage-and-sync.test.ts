import { describe, it, expect, vi } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { BrowserKeys, MemoryKeyStore, type KeyChangeEvent } from '..';

const applePem = () => generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;

describe('BrowserKeys staging', () => {
  it('a staged key signs without being stored, and commit() stores it', async () => {
    const store = new MemoryKeyStore();
    const events: KeyChangeEvent[] = [];
    const keys = new BrowserKeys({ store, onChange: (e) => events.push(e) });
    const staged = await keys.stageApple({ privateKeyPem: applePem(), keyId: 'ABC123DEF4', issuerId: 'issuer-1' });

    expect(staged.info).toMatchObject({ keyId: 'ABC123DEF4' });
    expect((await staged.keys.getAppleToken()).split('.')).toHaveLength(3);
    expect(await keys.info('apple')).toBeNull();
    expect(await store.get('apple')).toBeNull();
    expect(events).toEqual([]);

    await staged.commit();
    expect(await keys.info('apple')).toMatchObject({ keyId: 'ABC123DEF4' });
    expect(events).toEqual([{ type: 'saved', platform: 'apple' }]);
  });

  it('carries over a clock offset learned while proving', async () => {
    const keys = new BrowserKeys({ store: new MemoryKeyStore() });
    const staged = await keys.stageApple({ privateKeyPem: applePem(), keyId: 'ABC123DEF4', issuerId: 'issuer-1' });
    staged.keys.setClockOffsetMs(90_000);
    await staged.commit();
    expect(keys.getClockOffsetMs()).toBe(90_000);
  });

  it('an uncommitted stage leaves the stored key alone', async () => {
    const keys = new BrowserKeys({ store: new MemoryKeyStore() });
    await keys.importApple({ privateKeyPem: applePem(), keyId: 'OLDKEY1234', issuerId: 'issuer-1' });
    const before = await keys.getAppleToken();
    await keys.stageApple({ privateKeyPem: applePem(), keyId: 'NEWKEY5678', issuerId: 'issuer-2' });
    expect(await keys.info('apple')).toMatchObject({ keyId: 'OLDKEY1234' });
    expect(await keys.getAppleToken()).toBe(before);
  });
});

describe('BrowserKeys change events and dropCached', () => {
  it('reports saves and forgets, ids only', async () => {
    const onChange = vi.fn();
    const keys = new BrowserKeys({ store: new MemoryKeyStore(), onChange });
    await keys.importApple({ privateKeyPem: applePem(), keyId: 'ABC123DEF4', issuerId: 'issuer-1' });
    await keys.forget('apple');
    await keys.forgetAll();
    expect(onChange.mock.calls.map(([e]) => e)).toEqual([{ type: 'saved', platform: 'apple' }, { type: 'forgot', platform: 'apple' }, { type: 'forgotAll' }]);
  });

  it("dropCached makes another instance read the store again (another tab's change)", async () => {
    const store = new MemoryKeyStore();
    const tabA = new BrowserKeys({ store });
    const tabB = new BrowserKeys({ store });
    await tabA.importApple({ privateKeyPem: applePem(), keyId: 'ABC123DEF4', issuerId: 'issuer-1' });
    await tabB.getAppleToken();
    await tabA.forget('apple');
    // Still cached in tab B until it hears about the change
    expect(await tabB.info('apple')).not.toBeNull();
    tabB.dropCached('apple');
    expect(await tabB.info('apple')).toBeNull();
    await expect(tabB.getAppleToken()).rejects.toMatchObject({ code: 'not_connected' });
  });

  it('a failing listener never undoes the change', async () => {
    const keys = new BrowserKeys({
      store: new MemoryKeyStore(),
      onChange: () => {
        throw new Error('listener broke');
      },
    });
    await keys.importApple({ privateKeyPem: applePem(), keyId: 'ABC123DEF4', issuerId: 'issuer-1' });
    expect(await keys.info('apple')).not.toBeNull();
  });
});
