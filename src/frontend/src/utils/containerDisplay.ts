/**
 * Container display and hand-off helpers shared by the Folders page card and
 * the dashboard widget, so the two can never disagree about a container.
 */

import type { Container } from '@/stores/docker';

/**
 * The generic Docker whale, shown when a container's template names no icon.
 * BASE_URL differs between the dev server and the plugin path on Unraid, so the
 * URL has to be built rather than written as a literal.
 */
export const FALLBACK_CONTAINER_ICON = `${import.meta.env.BASE_URL}docker.svg`;

export interface ContainerStatus {
  /** Halo state class for ContainerIcon, e.g. `status-halo-success`. */
  halo: string;
  tooltip: string;
  /** Died on its own (isCrashedContainer), so the card can mark it. */
  crashed: boolean;
}

/**
 * The exit code in Docker's status line, "已退出（1）12 小时前" or
 * "Restarting (1) 5 seconds ago", or null when it has none. That line is the
 * only place the container list carries the code: /containers/json has no
 * ExitCode, and the inspect facts are cached per id, so they would go stale
 * on the next exit. A backend field would replace this one function.
 */
export function containerExitCode(container: Pick<Container, 'status'>): number | null {
  const match = /^(?:Exited|Restarting) \((-?\d+)\)/.exec(container.status ?? '');
  return match ? Number(match[1]) : null;
}

/**
 * The exit codes a `docker stop` gives: 0 for a clean exit, and 128 + the
 * signal for a process that died of it. 143 is SIGTERM, the default stop
 * signal, 137 SIGKILL after the stop timeout, and 130 / 131 SIGINT / SIGQUIT,
 * which some images set as STOPSIGNAL. 137 is also a kill for running out of
 * memory: the backends read State.OOMKilled for those (`oomKilled`). Docker
 * sets that when any process in the container ran out of memory during the
 * run, so a stop that timed out after a worker was killed for memory reads
 * as an out-of-memory crash too. An app that exits 1 from its own SIGTERM
 * handler still reads as a crash.
 */
// The backends' container watches keep the same set; stop-exit-codes.spec.ts
// in the plugin checks all three.
const STOP_EXIT_CODES = new Set([0, 130, 131, 137, 143]);

type CrashInput = Pick<Container, 'state' | 'status' | 'oomKilled' | 'processExited'>;
type StatusInput = CrashInput & Pick<Container, 'closedPorts' | 'unpublishedPorts'>;

/**
 * The process died on its own. Exited with a code no stop gives, or killed
 * for running out of memory; or restarting, which a restart policy only does
 * after an exit nobody asked for, so any code counts; or dead, which Docker
 * reports for a container it could not remove or clean up; or listed as
 * running after its process exited, which only the backends' container
 * watch can see. A container stopped from Unraid or `docker stop` is not one.
 */
export function isCrashedContainer(container: CrashInput): boolean {
  return crashKind(container) !== null;
}

/**
 * How the container crashed: its exit code when the status has one, and
 * whether that was a kill for memory. Null when it did not crash.
 */
function crashKind(container: CrashInput): { code: number | null; oom?: true; ghost?: true } | null {
  const { state } = container;
  if (state === 'running') return container.processExited ? { code: null, ghost: true } : null;
  if (state === 'dead') return { code: null };
  if (state !== 'exited' && state !== 'restarting') return null;
  const code = containerExitCode(container);
  if (code === 137 && container.oomKilled) return { code, oom: true };
  if (state === 'restarting') return { code };
  return code !== null && !STOP_EXIT_CODES.has(code) ? { code } : null;
}

/**
 * Kept in view while "隐藏已停止" is on: running, paused, or crashed. A
 * crash is what the user most needs to see, so hiding it with the stopped
 * containers would defeat marking it.
 */
export function isShownWhenHidingStopped(container?: CrashInput): boolean {
  return !!container && (isAliveContainer(container) || isCrashedContainer(container));
}

// Health/state is carried by a feathered halo around the container icon (see
// .status-halo in main.css). Halo and tooltip resolve together so a newly
// handled state can't land in one and be forgotten in the other — they were
// once two parallel branch chains.
export function containerStatus(container: StatusInput, distinguishHealthy: boolean): ContainerStatus {
  const state = container.state;
  const ok = (halo: string, tooltip: string): ContainerStatus => ({ halo, tooltip, crashed: false });
  const crash = crashKind(container);
  if (crash) {
    const verb = state === 'restarting' ? 'Crashing, restarting' : state === 'dead' ? 'Dead' : '已崩溃';
    const detail = crash.ghost
      ? ', though Docker still lists it as running'
      : crash.oom
        ? ' (out of memory)'
        : crash.code === null
          ? ''
          : ` (exit code ${crash.code})`;
    return { halo: 'status-halo-error', tooltip: `${verb}${detail}`, crashed: true };
  }
  if (state === 'running') {
    const portProblem = containerPortProblem(container);
    if (portProblem) return ok('status-halo-warning', `Running, but ${portProblem}`);
    if (!distinguishHealthy) return ok('status-halo-success', 'Running');
    return container.status?.toLowerCase().includes('(healthy)')
      ? ok('status-halo-success', 'Running (healthy)')
      : ok('status-halo-info', 'Running (no health check)');
  }
  if (state === 'paused') return ok('status-halo-warning', 'Paused');
  if (state === 'exited') return ok('status-halo-error', '已退出');
  if (state === 'stopped') return ok('status-halo-error', '已停止');
  if (state === 'created') return ok('status-halo-muted', '已创建');
  return ok('status-halo-muted', state.charAt(0).toUpperCase() + state.slice(1));
}

/**
 * What the backends' container watch found wrong with a running container's
 * ports, in words, or null. Each kind shows only after two sweeps in a row.
 */
export function containerPortProblem(container: Pick<Container, 'state' | 'closedPorts' | 'unpublishedPorts'>): string | null {
  if (container.state !== 'running') return null;
  const parts: string[] = [];
  const list = (noun: string, ports: number[]) => `${ports.length === 1 ? noun : `${noun}s`} ${ports.join(', ')}`;
  if (container.closedPorts?.length) parts.push(`nothing listens on ${list('port', container.closedPorts)}`);
  if (container.unpublishedPorts?.length) parts.push(`${list('host port', container.unpublishedPorts)} not published`);
  return parts.length ? parts.join('; ') : null;
}

/**
 * The container's WebUI link, with Unraid's `[IP]` and `[PORT:n]` template
 * placeholders filled in, or null when the template has no WebUI.
 */
export function containerWebuiUrl(container: Pick<Container, 'webui' | 'ports'>): string | null {
  const tpl = container.webui;
  if (!tpl) return null;
  return tpl
    .replace('[IP]', window.location.hostname)
    .replace(/\[PORT:(\d+)\]/g, (_match, privatePort) => {
      const mapped = container.ports?.find((p) => p.PrivatePort === parseInt(privatePort));
      return mapped?.PublicPort ? String(mapped.PublicPort) : privatePort;
    });
}

/**
 * Running, and not a process that exited while Docker still lists it as
 * running. What the running counts count: a dead database must not make its
 * folder read as fully running next to its own crashed pill.
 */
export function isRunningContainer(container: Pick<Container, 'state' | 'processExited'>): boolean {
  return container.state === 'running' && !container.processExited;
}

/** Running or paused. "隐藏已停止" keeps these, because both are alive. */
export function isAliveContainer(container?: Pick<Container, 'state'>): boolean {
  return container?.state === 'running' || container?.state === 'paused';
}

/** Unraid's edit form, or null when Unraid does not manage the container. */
export function containerEditUrl(container: Pick<Container, 'managed' | 'name'>): string | null {
  if (container.managed !== 'dockerman') return null;
  return `/Docker/UpdateContainer?xmlTemplate=edit:/boot/config/plugins/dockerMan/templates-user/my-${container.name}.xml`;
}

/**
 * Open Unraid's console or log terminal. `openTerminal` comes from dockerMan's
 * docker.js, which both the Docker page and the Dashboard load.
 */
export function openContainerTerminal(name: string, mode: 'console' | 'logs'): void {
  const more = mode === 'logs' ? '.log' : 'sh';
  const parentWindow = window.parent as typeof window & { openTerminal?: (tag: string, name: string, more: string) => void };
  if (parentWindow?.openTerminal) {
    parentWindow.openTerminal('docker', name, more);
  } else {
    // Fallback: open directly (dev mode or not in iframe)
    const suffix = mode === 'logs' ? `${encodeURIComponent(name)}.log` : encodeURIComponent(name);
    window.open(`/logterminal/${suffix}/`, '_blank');
  }
}
