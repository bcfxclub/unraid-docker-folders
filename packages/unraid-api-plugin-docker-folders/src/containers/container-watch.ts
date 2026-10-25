/**
 * The container watch's rules, ported from `classes/ContainerWatch.php`.
 * Pure, so they can be tested without a socket or /proc. See that file for
 * why each rule is what it is, and `container-watch.service.ts` for the
 * sweep that feeds them.
 */

import { parsePortBindings } from './container-facts.js';
import type { DockerInspectInfo, DockerListContainer } from './docker-client.js';
import { statusAgeUpperBound, uptimeUpperBound } from './docker-status.js';

/** An older sweep is not compared with: the runner has stopped. */
export const WATCH_STALE_SECONDS = 180;
/** An older sweep is not shown. See `ContainerWatch::SHOW_SECONDS`. */
export const WATCH_SHOW_SECONDS = 90;
/** This long without a problem clears an earlier notification. */
export const WATCH_RECOVERED_SECONDS = 600;
/** An exit this recent is inspected, so a crash between sweeps is seen. */
export const WATCH_FRESH_EXIT_SECONDS = 120;
/**
 * The exit codes a stop gives. The same set as `ContainerWatch::STOP_EXIT_CODES`
 * and the frontend's `STOP_EXIT_CODES`; `stop-exit-codes.spec.ts` checks all three.
 */
export const STOP_EXIT_CODES: ReadonlySet<number> = new Set([0, 130, 131, 137, 143]);

/** What the sweep reads off one inspect, plus what /proc says. */
export interface WatchInspect {
    running: boolean;
    startedAt: string;
    finishedAt: string;
    exitCode: number;
    oomKilled: boolean;
    networkMode: string;
    bindings: ReturnType<typeof parsePortBindings>;
    pidAlive: boolean;
    /** Ports in LISTEN state inside the container, null when not read. */
    listening: number[] | null;
    /** The network publishes ports at all (not macvlan, ipvlan, host or none). */
    publishesPorts: boolean;
}

export interface WatchObservation {
    id: string;
    name: string;
    state: string;
    status: string;
    published: number[];
    inspect: WatchInspect | null;
}

export interface WatchEntry {
    name: string;
    running: boolean;
    startedAt: string;
    alerted: boolean;
    portAlerted: boolean;
    /** When the port problem that was notified cleared, or null. */
    portQuietSince: number | null;
    open: number[];
    closedNow: number[];
    unpublishedNow: number[];
    processExited: boolean;
    closedPorts: number[];
    unpublishedPorts: number[];
}

export interface WatchSweep {
    at: number;
    containers: Map<string, WatchEntry>;
}

export interface WatchNotice {
    subject: string;
    description: string;
}

/** Running now, running at the last sweep, or exited within WATCH_FRESH_EXIT_SECONDS. */
export function idsToInspect(listed: DockerListContainer[], prev: WatchSweep | null): string[] {
    return listed
        .filter((container) => {
            if (container.State === 'running' || prev?.containers.get(container.Id)?.running === true) return true;
            const age = statusAgeUpperBound(container.Status ?? '');
            return age !== null && age <= WATCH_FRESH_EXIT_SECONDS;
        })
        .map((container) => container.Id);
}

/** The pure part of reading an inspect: everything /proc and the network do not say. */
export function fromInspect(inspect: DockerInspectInfo): Omit<WatchInspect, 'pidAlive' | 'listening' | 'publishesPorts'> {
    const state = inspect.State ?? {};
    return {
        // Mid-restart, Docker reports Running with no pid and a fresh
        // FinishedAt, which would read as a dead process.
        running: Boolean(state.Running) && !state.Restarting,
        startedAt: state.StartedAt ?? '',
        finishedAt: state.FinishedAt ?? '',
        exitCode: Number(state.ExitCode ?? 0),
        oomKilled: Boolean(state.OOMKilled),
        networkMode: inspect.HostConfig?.NetworkMode ?? '',
        bindings: parsePortBindings(inspect.HostConfig?.PortBindings),
    };
}

/** A container on the host's network, or on another container's, has no ports of its own. */
export function checksPorts(networkMode: string): boolean {
    return networkMode !== 'host' && !networkMode.startsWith('container:');
}

/** The local ports in LISTEN state in /proc/net/tcp or tcp6 text. */
export function listeningPorts(text: string): number[] {
    const ports = new Set<number>();
    for (const match of text.matchAll(/^\s*\d+:\s+[0-9A-Fa-f]+:([0-9A-Fa-f]{4})\s+[0-9A-Fa-f]+:[0-9A-Fa-f]{4}\s+0A\s/gm)) {
        ports.add(Number.parseInt(match[1], 16));
    }
    return [...ports].sort((a, b) => a - b);
}

export function observe(listed: DockerListContainer, inspect: WatchInspect | null): WatchObservation {
    const published = new Set<number>();
    for (const port of listed.Ports ?? []) {
        if (port.PublicPort !== undefined) published.add(port.PublicPort);
    }
    return {
        id: listed.Id,
        name: (listed.Names?.[0] ?? '').replace(/^\//, ''),
        state: listed.State ?? '',
        status: listed.Status ?? '',
        published: [...published],
        inspect,
    };
}

/**
 * Docker's RFC 3339 time in epoch seconds, or 0 for its zero time and for
 * anything unreadable. The fraction is dropped, as `ContainerWatch::timestamp`
 * has to.
 */
export function timestamp(value: string): number {
    const ms = Date.parse(value.replace(/\.\d+/, ''));
    return Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : 0;
}

const unique = (values: number[]) => [...new Set(values)];
const intersect = (a: number[], b: number[]) => a.filter((value) => b.includes(value));

/** The next sweep's state, and the notifications to send. Mirrors `ContainerWatch::plan`. */
export function planWatch(
    prev: WatchSweep | null,
    observations: WatchObservation[],
    now: number,
    /** When the host booted, 0 when unknown. */
    bootedAt = 0,
): { sweep: WatchSweep; notify: WatchNotice[] } {
    const containers = new Map<string, WatchEntry>();
    const notify: WatchNotice[] = [];
    for (const obs of observations) {
        if (obs.id === '') continue;
        const was = prev?.containers.get(obs.id);
        const seen = obs.inspect;
        // An inspect that failed says nothing new. Keep what the last sweep knew.
        if (seen === null && obs.state === 'running' && was?.running) {
            containers.set(obs.id, was);
            continue;
        }
        const entry: WatchEntry = {
            name: obs.name,
            running: obs.state === 'running',
            startedAt: seen?.startedAt ?? was?.startedAt ?? '',
            alerted: was?.alerted ?? false,
            portAlerted: was?.portAlerted ?? false,
            portQuietSince: was?.portQuietSince ?? null,
            open: [],
            closedNow: [],
            unpublishedNow: [],
            processExited: false,
            closedPorts: [],
            unpublishedPorts: [],
        };

        if (entry.running && seen !== null) {
            const started = timestamp(seen.startedAt);
            const finished = timestamp(seen.finishedAt);
            const finishedThisRun = started > 0 && finished > started && finished > bootedAt;
            entry.processExited = seen.running && (!seen.pidAlive || finishedThisRun);

            const sameRun = was !== undefined && was.running && was.startedAt === seen.startedAt;
            if (!entry.processExited && checksPorts(seen.networkMode)) {
                const tcp = unique(seen.bindings.filter((b) => b.type === 'tcp').map((b) => b.containerPort));
                const hostPorts = seen.bindings.map((b) => b.hostPort);
                let open = sameRun ? was.open : [];
                if (seen.listening !== null) {
                    const listening = seen.listening;
                    open = unique([...open, ...intersect(tcp, listening)]).sort((a, b) => a - b);
                    entry.closedNow = open.filter((port) => !listening.includes(port));
                }
                entry.open = open;
                if (seen.publishesPorts) {
                    entry.unpublishedNow = unique(hostPorts.filter((port) => !obs.published.includes(port)));
                }
                if (sameRun) {
                    entry.closedPorts = intersect(entry.closedNow, was.closedNow);
                    entry.unpublishedPorts = intersect(entry.unpublishedNow, was.unpublishedNow);
                }
            }

            // Two misses need an earlier sweep, so a problem implies `prev`.
            if (entry.closedPorts.length > 0 || entry.unpublishedPorts.length > 0) {
                entry.portQuietSince = null;
                if (!entry.portAlerted) {
                    notify.push(portText(obs.name, entry.closedPorts, entry.unpublishedPorts));
                    entry.portAlerted = true;
                }
            } else if (entry.portAlerted) {
                entry.portQuietSince ??= now;
                if (now - entry.portQuietSince >= WATCH_RECOVERED_SECONDS) {
                    entry.portAlerted = false;
                    entry.portQuietSince = null;
                }
            }

            if (entry.processExited) {
                if (prev !== null && !entry.alerted) {
                    // ExitCode is reset on start, so it is the dead process's
                    // only when FinishedAt shows this run ended.
                    notify.push(crashText(obs.name, 'running', finishedThisRun ? seen.exitCode : null, false));
                    entry.alerted = true;
                }
            } else if (started > 0 && now - started >= WATCH_RECOVERED_SECONDS) {
                entry.alerted = false;
            }
        } else if (!entry.running) {
            const code = seen !== null ? seen.exitCode : listedExitCode(obs.status);
            const oom = seen?.oomKilled ?? false;
            const crashed =
                obs.state === 'dead' ||
                obs.state === 'restarting' ||
                (obs.state === 'exited' && code !== null && (oom || !STOP_EXIT_CODES.has(code)));
            // Running at the last sweep, or exited since it.
            const sinceLast =
                prev !== null && (was?.running === true || (seen !== null && timestamp(seen.finishedAt) > prev.at));
            if (crashed && sinceLast && !entry.alerted) {
                notify.push(crashText(obs.name, obs.state, code, oom));
                entry.alerted = true;
            }
        }

        containers.set(obs.id, entry);
    }
    return { sweep: { at: now, containers }, notify };
}

function listedExitCode(status: string): number | null {
    const match = /^(?:Exited|Restarting) \((-?\d+)\)/.exec(status);
    return match ? Number(match[1]) : null;
}

/** The notification for a crash, worded as `ContainerWatch::crashText`. */
export function crashText(name: string, state: string, code: number | null, oom: boolean): WatchNotice {
    let description: string;
    if (state === 'running') {
        description = `${name}'s process ${code === null ? 'exited' : `exited with code ${code}`}, but Docker still lists it as running.`;
    }
    else if (state === 'dead') description = `Docker reports ${name} as dead.`;
    else if (oom) description = `${name} was killed for running out of memory.`;
    else if (state === 'restarting') description = `${name} exited with code ${code} and is restarting.`;
    else description = `${name} exited with code ${code}.`;
    return { subject: `Container crashed: ${name}`, description };
}

/** The notification for port problems, worded as `ContainerWatch::portText`. */
export function portText(name: string, closed: number[], unpublished: number[]): WatchNotice {
    const parts: string[] = [];
    if (closed.length > 0) parts.push(`nothing listens on ${portList('port', closed)}`);
    if (unpublished.length > 0) parts.push(`Docker has not published ${portList('host port', unpublished)}`);
    return { subject: `Container unreachable: ${name}`, description: `${name} is running, but ${parts.join(' and ')}.` };
}

function portList(noun: string, ports: number[]): string {
    return `${ports.length === 1 ? noun : `${noun}s`} ${ports.join(', ')}`;
}

export type WatchFindings = Pick<WatchEntry, 'processExited' | 'closedPorts' | 'unpublishedPorts'>;

const NO_FINDINGS: WatchFindings = { processExited: false, closedPorts: [], unpublishedPorts: [] };

/**
 * The sweep's findings on one listed container. Only for the run the sweep
 * saw: a container started after it has an uptime shorter than the time
 * since. Mirrors `ContainerWatch::annotate`.
 */
export function findingsFor(
    container: Pick<DockerListContainer, 'Id' | 'State' | 'Status'>,
    sweep: WatchSweep | null,
    now: number,
): WatchFindings {
    if (sweep === null || now - sweep.at > WATCH_SHOW_SECONDS) return NO_FINDINGS;
    const entry = sweep.containers.get(container.Id);
    if (!entry?.running || container.State !== 'running') return NO_FINDINGS;
    const uptime = uptimeUpperBound(container.Status ?? '');
    if (uptime === null || uptime < now - sweep.at) return NO_FINDINGS;
    return { processExited: entry.processExited, closedPorts: entry.closedPorts, unpublishedPorts: entry.unpublishedPorts };
}
