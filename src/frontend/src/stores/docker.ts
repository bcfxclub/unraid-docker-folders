/**
 * Docker Store - Manages container state
 */

import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import { useFolderStore } from './folders';
import { useSettingsStore } from './settings';
import { useBackend } from '@/backends';
import type { ContainerAction } from '@/backends/types';
import { naturalNameCompare, sortByMode } from '@/utils/sortMode';
import { containerMatchesSearch } from '@/utils/search';
import { composeProjectOf } from '@/utils/updateUnits';

export interface ContainerPort {
  IP: string;
  PrivatePort: number;
  PublicPort?: number;
  Type: string;
}

export interface ContainerMount {
  Source: string;
  Destination: string;
  Type: string;
  RW: boolean;
}

export interface HostPortBinding {
  hostIp: string;
  hostPort: number;
  containerPort: number;
  type: string; // 'tcp' | 'udp'
}

/**
 * The host ports a container holds right now.
 *
 * `hostPorts` comes from the backend's inspect cache, which skips a binding
 * with no fixed host port (`-p 80` or `-P`). Docker picks a new port for those
 * on every start, and that cache never expires, so storing one would go stale.
 * A running container reports the port Docker picked in the list response's
 * `ports[].PublicPort`, so it is read live here instead.
 */
export function heldBindings(c: Container): HostPortBinding[] {
  const held = [...(c.hostPorts ?? [])];
  if (c.state !== 'running') return held;
  for (const p of c.ports ?? []) {
    if (!p.PublicPort) continue;
    const type = (p.Type || 'tcp').toLowerCase();
    // Docker lists a port once per address family, and a fixed binding is
    // already in hostPorts. One entry per port and protocol is enough.
    if (held.some((b) => b.hostPort === p.PublicPort && b.type === type)) continue;
    held.push({ hostIp: p.IP ?? '', hostPort: p.PublicPort, containerPort: p.PrivatePort, type });
  }
  return held;
}

export interface ConflictDetail {
  hostPort: number;
  type: string;
  hostIp: string;
  heldBy: string[]; // names of running containers holding this port
}

export interface SecurityDismissal {
  container_name: string;
  finding_type: string;
}

export interface ConflictInfo {
  conflicts: ConflictDetail[];
}

export interface PullRequest {
  image: string;
  name: string;
  managed: string | null;
  id: string;
  force?: boolean;
  /** Apply an update pulled earlier: recreate this container, no pull. */
  recreateOnly?: boolean;
}

/**
 * Docker builds `Mounts` and the list API's `Ports` by walking a Go map, so
 * their order changes from one fetch to the next, and the details view would
 * swap rows on a refresh. Sort them once here, so every view gets one order:
 * mounts by container path, ports by container port, protocol, then host port.
 */
export function withStableOrder(c: Container): Container {
  return {
    ...c,
    mounts: [...(c.mounts ?? [])].sort((a, b) => a.Destination.localeCompare(b.Destination) || a.Source.localeCompare(b.Source)),
    ports: [...(c.ports ?? [])].sort(
      (a, b) => a.PrivatePort - b.PrivatePort || a.Type.localeCompare(b.Type) || (a.PublicPort ?? 0) - (b.PublicPort ?? 0) || (a.IP ?? '').localeCompare(b.IP ?? ''),
    ),
  };
}

export interface Container {
  id: string;
  name: string;
  image: string;
  /**
   * A newer image for this tag is on disk, but the container still runs the
   * old one. A pull leaves it like this until the container is recreated.
   */
  imageOutdated: boolean;
  state: string;
  status: string;
  command: string;
  ports: ContainerPort[];
  hostPorts: HostPortBinding[];
  mounts: ContainerMount[];
  networkSettings: Record<string, { IPAddress: string }>;
  /** HostConfig.NetworkMode, e.g. 'bridge', 'host', 'container:<id>'. */
  networkMode: string;
  privileged: boolean;
  capAdd: string[];
  /** Config.ExposedPorts keys, in Docker's own "8989/tcp" form. */
  exposedPorts: string[];
  /**
   * Config.User. Empty on most containers. A value can come from the image's
   * own USER rather than from an override, so it only means somebody chose the
   * user when it differs from `imageUser`.
   */
  user: string;
  /**
   * Config.User of the image the container was built from, empty when the
   * image declares none. Carried so `user` can be read as an override.
   */
  imageUser: string;
  /**
   * PUID and PGID from Config.Env, empty when the container does not set them.
   * On Unraid these, not `user`, decide who owns the files a container writes.
   */
  puid: string;
  pgid: string;
  /**
   * UMASK from Config.Env. Decides the mode of every file the container
   * creates, so it decides whether puid and pgid actually keep anyone out.
   * Empty means the image never overrode the default.
   */
  umask: string;
  /**
   * State.OOMKilled. Both backends read it only for a container whose last
   * exit was 137, which is a timed-out stop as often as a kill for memory.
   */
  oomKilled?: boolean;
  /**
   * From the backends' once-a-minute container watch. The process exited
   * while Docker still lists the container as running.
   */
  processExited?: boolean;
  /** Container ports seen listening earlier in this run that nothing listens on now. */
  closedPorts?: number[];
  /** Host ports the container asks for that Docker has not published. */
  unpublishedPorts?: number[];
  created: number;
  icon: string | null;
  managed: string | null;
  webui: string | null;
  labels: Record<string, string>;
  autostart: boolean;
  autostartDelay: number;
}

export interface ContainerActionFailure {
  action: ContainerAction;
  /** The backend's message, with Docker's own reason in it. */
  error: string;
  /** The state the failed action left the container in. */
  state: string;
}

export const useDockerStore = defineStore('docker', () => {
  // State
  const containers = ref<Container[]>([]);
  const loading = ref(false);
  const error = ref<string | null>(null);
  const searchQuery = ref('');
  /**
   * The compose project picked in the stacks pane, or null for no filter.
   * Applied with the search box everywhere the Folders page lists containers,
   * through `containerPassesFilters`.
   */
  const stackFilter = ref<string | null>(null);
  /**
   * Security findings the user accepted, as sent with the container list.
   * Held here rather than fetched separately so the security store converges
   * on every refresh path without a second request.
   */
  const securityDismissals = ref<SecurityDismissal[]>([]);
  let lastFetchTime = 0;
  const FETCH_DEBOUNCE_MS = 500;
  let initialLoadDone = false;

  // Getters
  const containerCount = computed(() => containers.value.length);

  const getContainerById = computed(() => {
    return (id: string) => containers.value.find((c) => c.id === id);
  });

  const containersByName = computed(() => {
    const map = new Map<string, Container>();
    for (const c of containers.value) map.set(c.name, c);
    return map;
  });

  // Treat unspecified / all-interfaces bindings as a wildcard that overlaps
  // any other host IP on the same port/protocol.
  const isWildcardIp = (ip: string) => ip === '' || ip === '0.0.0.0' || ip === '::';

  // Host port -> name of a container that binds it, over *every* container.
  // Deliberately wider than the `occupied` set inside portConflicts below,
  // which only counts running containers because that is what a conflict means.
  // The security advisor suggests a port to move to, and a stopped container
  // still owns its binding, so suggesting its port would collide on next start.
  const boundHostPorts = computed<Map<number, string>>(() => {
    const owners = new Map<number, string>();
    for (const c of containers.value) {
      for (const b of heldBindings(c)) {
        if (!owners.has(b.hostPort)) owners.set(b.hostPort, c.name);
      }
    }
    return owners;
  });

  // A non-running container has a port conflict when one of its configured
  // host port bindings collides with a binding held by a running container
  // (same port + protocol, with overlapping host IP). The map is keyed by
  // container id and only contains containers that actually conflict.
  const portConflicts = computed<Map<string, ConflictInfo>>(() => {
    // Occupied bindings from running containers.
    const occupied: Array<{ port: number; type: string; ip: string; name: string }> = [];
    for (const c of containers.value) {
      if (c.state !== 'running') continue;
      for (const b of heldBindings(c)) {
        occupied.push({ port: b.hostPort, type: b.type, ip: b.hostIp, name: c.name });
      }
    }

    const result = new Map<string, ConflictInfo>();
    if (occupied.length === 0) return result;

    for (const c of containers.value) {
      if (c.state === 'running') continue;
      const conflicts: ConflictDetail[] = [];

      for (const b of c.hostPorts ?? []) {
        const heldBy = new Set<string>();
        for (const o of occupied) {
          if (o.port !== b.hostPort || o.type !== b.type) continue;
          if (isWildcardIp(b.hostIp) || isWildcardIp(o.ip) || o.ip === b.hostIp) {
            heldBy.add(o.name);
          }
        }
        if (heldBy.size > 0) {
          conflicts.push({
            hostPort: b.hostPort,
            type: b.type,
            hostIp: b.hostIp,
            heldBy: [...heldBy],
          });
        }
      }

      if (conflicts.length > 0) {
        result.set(c.id, { conflicts });
      }
    }

    return result;
  });

  const getPortConflict = computed(() => {
    return (id: string) => portConflicts.value.get(id) ?? null;
  });

  const stateOrder: Record<string, number> = {
    exited: 0,
    running: 1,
    created: 2,
  };

  const sortedContainers = computed(() => {
    return [...containers.value].sort((a, b) => {
      return (stateOrder[a.state] ?? 3) - (stateOrder[b.state] ?? 3);
    });
  });

  const isFiltering = computed(() => searchQuery.value.trim().length > 0 || stackFilter.value !== null);

  /**
   * Whether a container passes both the search box and the stack filter.
   * `name` is the folder association's name, used when the container itself
   * is gone (a stale association): it can still match a search, but it has
   * no labels, so it never matches a stack.
   */
  function containerPassesFilters(container: Container | undefined, name: string): boolean {
    if (stackFilter.value !== null && (!container || composeProjectOf(container) !== stackFilter.value)) {
      return false;
    }
    return containerMatchesSearch(searchQuery.value, container?.name ?? name, container?.image);
  }

  /** Containers grouped by compose project, from their labels. */
  const containersByProject = computed(() => {
    const map = new Map<string, Container[]>();
    for (const c of containers.value) {
      const project = composeProjectOf(c);
      if (!project) continue;
      const list = map.get(project);
      if (list) list.push(c);
      else map.set(project, [c]);
    }
    return map;
  });

  /** The containers of a compose project. */
  function containersInStack(project: string): Container[] {
    return containersByProject.value.get(project) ?? [];
  }

  /**
   * Whether the stack filter keeps a compose folder that none of its
   * containers would keep: the picked stack's own folder while the stack has
   * no containers at all, so it can preview its services and be started.
   * Once any container exists, the containers decide, as for every folder.
   */
  function stackFilterKeepsDownStackFolder(folderProject: string | null): boolean {
    const project = stackFilter.value;
    return project !== null && folderProject === project && containersInStack(project).length === 0;
  }

  const unfolderedContainers = computed(() => {
    // Membership is keyed on name (stable across recreations); the folder
    // store owns the one map of it.
    const folderStore = useFolderStore();
    const settingsStore = useSettingsStore();
    const assigned = folderStore.folderByContainerName;

    if (settingsStore.sortMode !== 'manual') {
      const unfoldered = sortedContainers.value.filter((c) => !assigned.has(c.name));
      return sortByMode(unfoldered, settingsStore.sortMode, (c) => ({
        position: 0,
        name: c.name,
        state: c.state,
        created: c.created,
      }));
    }

    // Manual: saved order first. The backend gives each unfoldered container a
    // position on list load (primeUnfolderedOrder, same naturalNameCompare); until the
    // next folder fetch the rest follow by name, so a start or stop never moves
    // them. A folder member is never listed even if its name is ranked.
    const rank = new Map<string, number>();
    folderStore.unfolderedOrder.forEach((name, i) => {
      if (!rank.has(name)) rank.set(name, i);
    });
    const ranked: Container[] = [];
    const unranked: Container[] = [];
    for (const c of containers.value) {
      if (!assigned.has(c.name)) (rank.has(c.name) ? ranked : unranked).push(c);
    }
    ranked.sort((a, b) => rank.get(a.name)! - rank.get(b.name)!);
    return [...ranked, ...unranked.sort((a, b) => naturalNameCompare(a.name, b.name))];
  });

  // Actions
  async function fetchContainers(force = false) {
    const now = Date.now();
    if (!force && now - lastFetchTime < FETCH_DEBOUNCE_MS) {
      return;
    }
    lastFetchTime = now;

    // Only show loading spinner on initial load
    if (!initialLoadDone) {
      loading.value = true;
    }
    error.value = null;

    try {
      const { ok, error: failure, data } = await useBackend().containers.list();

      if (!ok) {
        throw new Error(failure);
      }

      containers.value = (data.containers || []).map(withStableOrder);
      securityDismissals.value = data.dismissals || [];
      pruneActionFailures();
      initialLoadDone = true;
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Unknown error';
      console.error('Error fetching containers:', e);
    } finally {
      loading.value = false;
    }
  }

  /**
   * The last failed start, resume, stop, restart or remove on each container,
   * keyed by name so it survives a recreate. Holds the daemon's own reason
   * (for example "endpoint with name X already exists in network bridge"),
   * which the card shows until it is dismissed or stops being true.
   */
  const actionFailures = ref(new Map<string, ContainerActionFailure>());

  function actionFailureFor(container: Container): ContainerActionFailure | undefined {
    return actionFailures.value.get(container.name);
  }

  /**
   * Drop each failure whose container is gone or has left the state the
   * failed action left it in, from the plugin or from outside it. Runs on
   * every fetch, so a stale failure never comes back when the container
   * later returns to that state.
   */
  function pruneActionFailures() {
    if (actionFailures.value.size === 0) return;
    const stateByName = new Map(containers.value.map((c) => [c.name, c.state]));
    for (const [name, failure] of actionFailures.value) {
      if (stateByName.get(name) !== failure.state) actionFailures.value.delete(name);
    }
  }

  function dismissActionFailure(name: string) {
    actionFailures.value.delete(name);
  }

  async function runContainerAction(action: ContainerAction, id: string, body?: { remove_image: true }): Promise<boolean> {
    const container = containers.value.find((c) => c.id === id);
    if (container) actionFailures.value.delete(container.name);

    let failure: string | undefined;
    try {
      const result = await useBackend().containers.action(action, id, body);
      if (!result.ok) failure = result.error || `Could not ${action} container`;
    } catch (e) {
      failure = e instanceof Error ? e.message : String(e);
    }
    if (failure !== undefined) {
      console.error(`Error running ${action} on container:`, failure);
      if (container) {
        // Record the state the failed action left, not the one before it: a
        // failed restart leaves a running container exited.
        await fetchContainers(true);
        const after = containers.value.find((c) => c.name === container.name);
        actionFailures.value.set(container.name, { action, error: failure, state: after?.state ?? container.state });
      }
      return false;
    }

    // A remove also drops the container's folder rows on the backend.
    if (action === 'remove') await Promise.all([fetchContainers(), useFolderStore().fetchFolders()]);
    else await fetchContainers();
    return true;
  }

  const startContainer = (id: string) => runContainerAction('start', id);
  const resumeContainer = (id: string) => runContainerAction('resume', id);
  const stopContainer = (id: string) => runContainerAction('stop', id);
  const restartContainer = (id: string) => runContainerAction('restart', id);
  const removeContainer = (id: string, removeImage = false) =>
    runContainerAction('remove', id, removeImage ? { remove_image: true } : undefined);

  async function toggleAutostart(name: string, enabled: boolean, delay?: number): Promise<boolean> {
    try {
      const body: { enabled: boolean; delay?: number } = { enabled };
      if (delay !== undefined) body.delay = delay;
      const { ok } = await useBackend().containers.setAutostart(name, body);
      if (!ok) {
        throw new Error('Failed to update autostart');
      }
      // Update local state immediately
      const container = containers.value.find(c => c.name === name);
      if (container) {
        container.autostart = enabled;
        if (delay !== undefined) container.autostartDelay = delay;
      }
      return true;
    } catch (e) {
      console.error('Error toggling autostart:', e);
      return false;
    }
  }

  return {
    // State
    containers,
    loading,
    error,
    searchQuery,
    stackFilter,

    // Getters
    isFiltering,
    containerPassesFilters,
    containersByProject,
    containersInStack,
    stackFilterKeepsDownStackFolder,
    containerCount,
    getContainerById,
    containersByName,
    sortedContainers,
    unfolderedContainers,
    portConflicts,
    getPortConflict,
    boundHostPorts,
    securityDismissals,

    // Actions
    fetchContainers,
    actionFailures,
    actionFailureFor,
    dismissActionFailure,
    startContainer,
    resumeContainer,
    stopContainer,
    restartContainer,
    removeContainer,
    toggleAutostart,
  };
});
