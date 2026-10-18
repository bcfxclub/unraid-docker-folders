import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { useDockerStore } from '../docker';
import { useFolderStore } from '../folders';
import { useSettingsStore } from '../settings';
import { makeContainer, makeFolder } from '@/test/fixtures';

// Mock apiFetch so instantiating the stores never makes real HTTP requests.
vi.mock('@/utils/csrf', () => ({
  apiFetch: vi.fn(),
  getCsrfToken: vi.fn(() => ''),
}));

function names(store: ReturnType<typeof useDockerStore>): string[] {
  return store.unfolderedContainers.map((c) => c.name);
}

describe('docker store – unfolderedContainers with a saved order', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('falls back to name order when no order is saved', () => {
    const store = useDockerStore();
    store.containers = [
      makeContainer({ id: 'c', name: 'charlie', state: 'created' }),
      makeContainer({ id: 'b', name: 'bravo', state: 'running' }),
      makeContainer({ id: 'a', name: 'alpha', state: 'exited' }),
    ];

    expect(names(store)).toEqual(['alpha', 'bravo', 'charlie']);
  });

  it('does not move an unranked container when its state changes', () => {
    const store = useDockerStore();
    store.containers = [
      makeContainer({ id: 'a', name: 'alpha', state: 'running' }),
      makeContainer({ id: 'b', name: 'bravo', state: 'running' }),
      makeContainer({ id: 'c', name: 'charlie', state: 'running' }),
    ];
    const before = names(store);

    store.containers = store.containers.map((c) => (c.name === 'bravo' ? { ...c, state: 'exited' } : c));

    expect(names(store)).toEqual(before);
  });

  it('applies the saved order regardless of container state', () => {
    const store = useDockerStore();
    const folderStore = useFolderStore();
    store.containers = [
      makeContainer({ id: 'c', name: 'created', state: 'created' }),
      makeContainer({ id: 'r', name: 'running', state: 'running' }),
      makeContainer({ id: 'e', name: 'exited', state: 'exited' }),
    ];
    folderStore.unfolderedOrder = ['created', 'running', 'exited'];

    expect(names(store)).toEqual(['created', 'running', 'exited']);
  });

  it('lists unranked containers after the ranked ones, by name', () => {
    const store = useDockerStore();
    const folderStore = useFolderStore();
    store.containers = [
      makeContainer({ id: 'a', name: 'alpha', state: 'running' }),
      makeContainer({ id: 'b', name: 'beta', state: 'created' }),
      makeContainer({ id: 'g', name: 'gamma', state: 'exited' }),
      makeContainer({ id: 'd', name: 'delta', state: 'running' }),
    ];
    folderStore.unfolderedOrder = ['delta', 'beta'];

    // delta and beta take the saved order; alpha and gamma follow by name.
    expect(names(store)).toEqual(['delta', 'beta', 'alpha', 'gamma']);
  });

  it('ignores names in the saved order that match no container', () => {
    const store = useDockerStore();
    const folderStore = useFolderStore();
    store.containers = [
      makeContainer({ id: 'a', name: 'alpha', state: 'running' }),
      makeContainer({ id: 'b', name: 'beta', state: 'running' }),
    ];
    folderStore.unfolderedOrder = ['ghost', 'beta', 'phantom', 'alpha'];

    expect(names(store)).toEqual(['beta', 'alpha']);
  });

  it('excludes a folder member even when it is ranked', () => {
    const store = useDockerStore();
    const folderStore = useFolderStore();
    store.containers = [
      makeContainer({ id: 'p', name: 'plex', state: 'running' }),
      makeContainer({ id: 'a', name: 'alpha', state: 'running' }),
      makeContainer({ id: 'b', name: 'beta', state: 'running' }),
    ];
    folderStore.folders = [makeFolder(['plex'])];
    folderStore.unfolderedOrder = ['plex', 'beta', 'alpha'];

    expect(names(store)).toEqual(['beta', 'alpha']);
  });

  it('uses the global sort mode instead of the saved order when it is not manual', () => {
    const store = useDockerStore();
    const folderStore = useFolderStore();
    const settingsStore = useSettingsStore();
    store.containers = [
      makeContainer({ id: 'c', name: 'charlie', state: 'running' }),
      makeContainer({ id: 'a', name: 'alpha', state: 'exited' }),
      makeContainer({ id: 'b', name: 'bravo', state: 'running' }),
    ];
    folderStore.unfolderedOrder = ['charlie', 'bravo', 'alpha'];

    settingsStore.sortMode = 'name-asc';
    expect(names(store)).toEqual(['alpha', 'bravo', 'charlie']);

    settingsStore.sortMode = 'manual';
    expect(names(store)).toEqual(['charlie', 'bravo', 'alpha']);
  });

  it('orders unranked names the way both backends prime them', () => {
    const store = useDockerStore();
    store.containers = ['app_db', 'app-db', 'app.db', 'appdb', 'app2', 'app10', 'App1', 'app01'].map((name) => makeContainer({ id: name, name }));

    // Same fixture as FolderManagerTest and folder.service.spec.
    expect(names(store)).toEqual(['App1', 'app01', 'app2', 'app10', 'app-db', 'app.db', 'app_db', 'appdb']);
  });
});
