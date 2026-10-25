import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { useComposeStore } from '../compose';

vi.mock('@/utils/csrf', () => ({
  apiFetch: vi.fn(),
  getCsrfToken: vi.fn(() => ''),
}));

import { apiFetch } from '@/utils/csrf';

const mockApiFetch = vi.mocked(apiFetch);

const reply = (ok: boolean, body: Record<string, unknown>) => ({ ok, json: async () => body }) as Response;

describe('compose store – runStackAction', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    mockApiFetch.mockReset();
  });

  it('shows the action while it runs and clears it on success', async () => {
    mockApiFetch.mockResolvedValue(reply(true, { success: true, stacks: [], containers: [], folders: [] }));
    const store = useComposeStore();
    const run = store.runStackAction('arr', 'down');
    expect(store.stackActionStatus.get('arr')).toEqual({ kind: 'down' });
    expect(store.isStackBusy('arr')).toBe(true);
    await run;
    expect(store.stackActionStatus.has('arr')).toBe(false);
  });

  it('keeps a failure until something clears it', async () => {
    mockApiFetch.mockResolvedValue(reply(false, { message: 'compose down failed' }));
    const store = useComposeStore();
    await store.runStackAction('arr', 'down');
    expect(store.stackActionStatus.get('arr')).toEqual({ kind: 'down', error: 'compose down failed' });
    expect(store.isStackBusy('arr')).toBe(false);
    store.clearStackStatus('arr');
    expect(store.stackActionStatus.has('arr')).toBe(false);
  });

  it('never clears or doubles an action still running', async () => {
    mockApiFetch.mockResolvedValue(reply(true, { success: true }));
    const store = useComposeStore();
    const run = store.runStackAction('arr', 'stop');
    store.clearStackStatus('arr');
    await store.runStackAction('arr', 'down');
    expect(store.stackActionStatus.get('arr')?.kind).toBe('stop');
    await run;
  });

  it('disables every action on that stack, and only that stack, while one runs', async () => {
    mockApiFetch.mockResolvedValue(reply(true, { success: true }));
    const store = useComposeStore();
    store.status = { ...store.status, compose_available: true, management_enabled: true };
    store.statusChecked = true;
    const run = store.runStackAction('arr', 'down');
    expect(store.stackActionsDisabled('arr')).toBe(true);
    expect(store.stackDisabledReason('arr')).toBe('Removing…');
    expect(store.stackActionsDisabled('media')).toBe(false);
    await run;
    expect(store.stackActionsDisabled('arr')).toBe(false);
  });
});
