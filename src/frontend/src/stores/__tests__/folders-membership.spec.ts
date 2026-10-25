import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { useFolderStore } from '../folders';
import type { Folder } from '@/types/folder';
import { makeFolder } from '@/test/fixtures';

// Mock apiFetch so no real HTTP requests are made
vi.mock('@/utils/csrf', () => ({
  apiFetch: vi.fn(),
  getCsrfToken: vi.fn(() => ''),
}));

import { apiFetch } from '@/utils/csrf';

const mockApiFetch = vi.mocked(apiFetch);

/** Every mutation endpoint returns `{ folder }`; the store swaps it into state. */
function okResponse(folder: Folder): Response {
  return { ok: true, json: async () => ({ success: true, folder }) } as Response;
}

/** The URLs of every apiFetch call, in order. */
function calledUrls(): string[] {
  return mockApiFetch.mock.calls.map((c) => String(c[0]));
}

describe('folders store – setFolderContainers', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    mockApiFetch.mockReset();
    mockApiFetch.mockImplementation(async () => okResponse(makeFolder([])));
  });

  it('issues no requests when the desired set already matches the folder', async () => {
    const store = useFolderStore();
    store.folders = [makeFolder(['plex', 'sonarr', 'radarr'])];

    // Same members, deliberately in a different order.
    const ok = await store.setFolderContainers(1, [
      { id: 'id-radarr', name: 'radarr' },
      { id: 'id-plex', name: 'plex' },
      { id: 'id-sonarr', name: 'sonarr' },
    ]);

    expect(ok).toBe(true);
    expect(mockApiFetch).not.toHaveBeenCalled();
  });

  it('adds only the new container, leaving existing members untouched', async () => {
    const store = useFolderStore();
    store.folders = [makeFolder(['plex', 'sonarr'])];

    await store.setFolderContainers(1, [
      { id: 'id-plex', name: 'plex' },
      { id: 'id-sonarr', name: 'sonarr' },
      { id: 'id-bazarr', name: 'bazarr' },
    ]);

    const adds = calledUrls().filter((u) => u.includes('action=add_container'));
    expect(adds).toHaveLength(1);

    const body = String(mockApiFetch.mock.calls[0][1]?.body);
    expect(JSON.parse(body)).toEqual({ container_id: 'id-bazarr', container_name: 'bazarr' });
  });

  it('removes a container that is no longer in the desired set', async () => {
    const store = useFolderStore();
    store.folders = [makeFolder(['plex', 'sonarr'])];

    await store.setFolderContainers(1, [{ id: 'id-plex', name: 'plex' }]);

    const removes = calledUrls().filter((u) => u.includes('action=remove_container'));
    expect(removes).toHaveLength(1);
    expect(calledUrls().some((u) => u.includes('action=add_container'))).toBe(false);
  });

  it('removes every member when the desired set is empty', async () => {
    const store = useFolderStore();
    store.folders = [makeFolder(['plex', 'sonarr'])];

    await store.setFolderContainers(1, []);

    const removes = calledUrls().filter((u) => u.includes('action=remove_container'));
    expect(removes).toHaveLength(2);
  });

  it('issues removals before additions', async () => {
    const store = useFolderStore();
    store.folders = [makeFolder(['plex', 'sonarr'])];

    await store.setFolderContainers(1, [
      { id: 'id-plex', name: 'plex' },
      { id: 'id-bazarr', name: 'bazarr' },
    ]);

    const actions = calledUrls()
      .filter((u) => u.includes('action=add_container') || u.includes('action=remove_container'))
      .map((u) => (u.includes('remove_container') ? 'remove' : 'add'));

    expect(actions).toEqual(['remove', 'add']);
  });

  it('ignores a desired entry that is already a member but was not shown in the picker', async () => {
    const store = useFolderStore();
    store.folders = [makeFolder(['plex', 'ghost'])];

    // 'ghost' is passed straight through from the folder's own associations
    // because Docker is not currently reporting it.
    await store.setFolderContainers(1, [
      { id: 'id-plex', name: 'plex' },
      { id: 'id-ghost', name: 'ghost' },
    ]);

    expect(mockApiFetch).not.toHaveBeenCalled();
  });

  it('drops entries with an empty name so they cannot collide on UNIQUE(container_name)', async () => {
    const store = useFolderStore();
    store.folders = [makeFolder(['plex'])];

    await store.setFolderContainers(1, [
      { id: 'id-plex', name: 'plex' },
      { id: 'unresolved-a', name: '' },
      { id: 'unresolved-b', name: '' },
    ]);

    expect(mockApiFetch).not.toHaveBeenCalled();
  });

  it('returns false and issues no requests for an unknown folder', async () => {
    const store = useFolderStore();
    store.folders = [makeFolder(['plex'])];

    const ok = await store.setFolderContainers(999, [{ id: 'id-x', name: 'x' }]);

    expect(ok).toBe(false);
    expect(mockApiFetch).not.toHaveBeenCalled();
  });

  it('reports failure when an add fails', async () => {
    const store = useFolderStore();
    store.folders = [makeFolder(['plex'])];
    mockApiFetch.mockImplementation(async () => ({ ok: false }) as Response);

    const ok = await store.setFolderContainers(1, [
      { id: 'id-plex', name: 'plex' },
      { id: 'id-bazarr', name: 'bazarr' },
    ]);

    expect(ok).toBe(false);
  });
});

describe('folders store – moveContainerToFolder', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    mockApiFetch.mockReset();
  });

  it('takes the container out of the source folder before the refetch', async () => {
    const store = useFolderStore();
    store.folders = [
      makeFolder(['plex', 'sonarr'], { id: 1 }),
      makeFolder(['nginx'], { id: 2, name: 'Web' }),
    ];

    let sourceDuringRefetch: string[] = [];
    mockApiFetch.mockImplementation(async (url) => {
      if (String(url).includes('action=add_container')) {
        return okResponse(makeFolder(['nginx', 'plex'], { id: 2, name: 'Web' }));
      }
      // The refetch fails, so only the local update can clear the source.
      sourceDuringRefetch = store.folders[0].containers.map((c) => c.container_name);
      return { ok: false, status: 500 } as Response;
    });

    const ok = await store.moveContainerToFolder(2, 'id-plex', 'plex');

    expect(ok).toBe(true);
    expect(sourceDuringRefetch).toEqual(['sonarr']);
    expect(store.folders[0].containers.map((c) => c.container_name)).toEqual(['sonarr']);
    expect(store.folders[1].containers.map((c) => c.container_name)).toEqual(['nginx', 'plex']);
  });

  it('puts the container back in the source folder when the add fails', async () => {
    const store = useFolderStore();
    store.folders = [
      makeFolder(['plex', 'sonarr'], { id: 1 }),
      makeFolder(['nginx'], { id: 2, name: 'Web' }),
    ];
    mockApiFetch.mockImplementation(async () => ({ ok: false, status: 500 }) as Response);

    const ok = await store.moveContainerToFolder(2, 'id-plex', 'plex');

    expect(ok).toBe(false);
    expect(store.folders[0].containers.map((c) => c.container_name)).toEqual(['plex', 'sonarr']);
    expect(store.folders[1].containers.map((c) => c.container_name)).toEqual(['nginx']);
  });
});

describe('folders store – moveContainerToFolder at a drop position', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    mockApiFetch.mockReset();
  });

  function reorderBody(): string[] | undefined {
    const call = mockApiFetch.mock.calls.find((c) => String(c[0]).includes('action=reorder_containers'));
    if (!call) return undefined;
    return JSON.parse(String(call[1]?.body)).container_ids;
  }

  it('saves the moved container in front of the one it was dropped before', async () => {
    const store = useFolderStore();
    store.folders = [
      makeFolder(['mimir'], { id: 1, name: 'grafana' }),
      makeFolder(['tempo', 'loki', 'postgres'], { id: 2, name: 'Databases' }),
    ];
    mockApiFetch.mockImplementation(async (url) => {
      if (String(url).includes('action=add_container')) {
        // The backend appends it at the end.
        return okResponse(makeFolder(['tempo', 'loki', 'postgres', 'mimir'], { id: 2, name: 'Databases' }));
      }
      return okResponse(makeFolder(['tempo', 'mimir', 'loki', 'postgres'], { id: 2, name: 'Databases' }));
    });

    await store.moveContainerToFolder(2, 'id-mimir', 'mimir', 'loki');

    expect(reorderBody()).toEqual(['id-tempo', 'id-mimir', 'id-loki', 'id-postgres']);
  });

  it('leaves the backend order alone without a drop position', async () => {
    const store = useFolderStore();
    store.folders = [makeFolder(['mimir'], { id: 1 }), makeFolder(['tempo'], { id: 2 })];
    mockApiFetch.mockImplementation(async () => okResponse(makeFolder(['tempo', 'mimir'], { id: 2 })));

    await store.moveContainerToFolder(2, 'id-mimir', 'mimir');

    expect(reorderBody()).toBeUndefined();
  });

  it('does not reorder when the add fails', async () => {
    const store = useFolderStore();
    store.folders = [makeFolder(['mimir'], { id: 1 }), makeFolder(['tempo'], { id: 2 })];
    mockApiFetch.mockImplementation(async () => ({ ok: false, status: 500 }) as Response);

    await store.moveContainerToFolder(2, 'id-mimir', 'mimir', 'tempo');

    expect(reorderBody()).toBeUndefined();
  });
});

describe('folders store – reorderContainers', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    mockApiFetch.mockReset();
  });

  const names = (store: ReturnType<typeof useFolderStore>) =>
    [...store.folders[0].containers].sort((a, b) => a.position - b.position).map((c) => c.container_name);

  it('shows the new order before the response lands', async () => {
    let answer!: (r: Response) => void;
    mockApiFetch.mockImplementation(() => new Promise((r) => { answer = r; }));
    const store = useFolderStore();
    store.folders = [makeFolder(['a', 'b', 'c'])];

    const pending = store.reorderContainers(1, ['id-c', 'id-a', 'id-b']);
    expect(names(store)).toEqual(['c', 'a', 'b']);
    answer(okResponse(makeFolder(['c', 'a', 'b'])));
    await pending;
    expect(names(store)).toEqual(['c', 'a', 'b']);
  });

  it('goes back to the old order when the save fails', async () => {
    mockApiFetch.mockResolvedValue({ ok: false, status: 500 } as Response);
    const store = useFolderStore();
    store.folders = [makeFolder(['a', 'b', 'c'])];

    const ok = await store.reorderContainers(1, ['id-c', 'id-a', 'id-b']);

    expect(ok).toBe(false);
    expect(names(store)).toEqual(['a', 'b', 'c']);
  });
});

describe('getFolderForContainer', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    mockApiFetch.mockReset();
  });

  it('finds the folder a container belongs to by name, or undefined when unfoldered', () => {
    const store = useFolderStore();
    store.folders = [
      makeFolder(['plex'], { id: 1, name: 'Media' }),
      makeFolder(['nginx'], { id: 2, name: 'Web' }),
    ];

    expect(store.getFolderForContainer('nginx')?.name).toBe('Web');
    expect(store.getFolderForContainer('plex')?.name).toBe('Media');
    expect(store.getFolderForContainer('orphan')).toBeUndefined();
  });
});
