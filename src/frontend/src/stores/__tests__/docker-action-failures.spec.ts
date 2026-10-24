import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { useDockerStore } from '../docker';
import { makeContainer } from '@/test/fixtures';

vi.mock('@/utils/csrf', () => ({
  apiFetch: vi.fn(),
  getCsrfToken: vi.fn(() => ''),
}));

import { apiFetch } from '@/utils/csrf';

const mockApiFetch = vi.mocked(apiFetch);

const REASON =
  'Could not start container: failed to set up container networking: endpoint with name postgresql16 already exists in network bridge';

const reply = (ok: boolean, body: Record<string, unknown>, status = ok ? 200 : 500) =>
  ({ ok, status, json: async () => body }) as Response;

describe('docker store – action failures', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    mockApiFetch.mockReset();
  });

  const pg = (state: string) => makeContainer({ id: 'pg', name: 'postgresql16', state });
  const list = (state: string) => reply(true, { success: true, containers: [pg(state)] });
  const failure = () => reply(false, { error: true, message: REASON });

  function storeWith(state: string) {
    const store = useDockerStore();
    store.containers = [pg(state)];
    return store;
  }

  it('keeps the backend\'s reason when a start fails', async () => {
    mockApiFetch.mockResolvedValueOnce(failure()).mockResolvedValueOnce(list('exited'));
    const store = storeWith('exited');

    expect(await store.startContainer('pg')).toBe(false);
    expect(store.actionFailureFor(store.containers[0])).toEqual({ action: 'start', error: REASON, state: 'exited' });
  });

  it('records the state a failed restart left, so the reason shows on the exited card', async () => {
    mockApiFetch.mockResolvedValueOnce(failure()).mockResolvedValueOnce(list('exited'));
    const store = storeWith('running');

    await store.restartContainer('pg');
    expect(store.containers[0].state).toBe('exited');
    expect(store.actionFailureFor(store.containers[0])?.state).toBe('exited');
  });

  it('drops the failure once the state changes, and does not bring it back later', async () => {
    mockApiFetch.mockResolvedValueOnce(failure()).mockResolvedValueOnce(list('exited'));
    const store = storeWith('exited');
    await store.startContainer('pg');

    mockApiFetch.mockResolvedValueOnce(list('running'));
    await store.fetchContainers(true);
    expect(store.actionFailures.has('postgresql16')).toBe(false);

    mockApiFetch.mockResolvedValueOnce(list('exited'));
    await store.fetchContainers(true);
    expect(store.actionFailureFor(store.containers[0])).toBeUndefined();
  });

  it('drops the failure of a container that is gone', async () => {
    mockApiFetch.mockResolvedValueOnce(failure()).mockResolvedValueOnce(list('exited'));
    const store = storeWith('exited');
    await store.startContainer('pg');

    mockApiFetch.mockResolvedValueOnce(reply(true, { success: true, containers: [] }));
    await store.fetchContainers(true);
    expect(store.actionFailures.size).toBe(0);
  });

  it('clears an old failure when the next action starts, and on dismiss', async () => {
    mockApiFetch.mockResolvedValueOnce(failure()).mockResolvedValueOnce(list('exited'));
    const store = storeWith('exited');
    await store.startContainer('pg');

    mockApiFetch.mockResolvedValue(list('exited'));
    expect(await store.startContainer('pg')).toBe(true);
    expect(store.actionFailures.has('postgresql16')).toBe(false);

    mockApiFetch.mockResolvedValueOnce(failure()).mockResolvedValueOnce(list('exited'));
    await store.startContainer('pg');
    expect(store.actionFailures.has('postgresql16')).toBe(true);
    store.dismissActionFailure('postgresql16');
    expect(store.actionFailures.has('postgresql16')).toBe(false);
  });
});
