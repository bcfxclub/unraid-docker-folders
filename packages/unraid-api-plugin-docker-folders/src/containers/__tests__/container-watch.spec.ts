import { describe, expect, it } from 'vitest';

import {
    findingsFor,
    listeningPorts,
    observe,
    planWatch,
    timestamp,
    type WatchInspect,
    type WatchNotice,
    type WatchObservation,
    type WatchSweep,
} from '../container-watch.js';
import type { DockerListContainer } from '../docker-client.js';
import { uptimeUpperBound } from '../docker-status.js';

// Mirrors tests/php/ContainerWatchTest.php.
const NOW = 1_800_000_000;
const STARTED = '2027-01-15T07:00:00.123456789Z';
const iso = (seconds: number) => new Date(seconds * 1000).toISOString().replace('.000', '');

const listed = (State: string, Status: string, published: number[] = []): DockerListContainer => ({
    Id: 'pg',
    Names: ['/postgresql16'],
    State,
    Status,
    Ports: published.map((PublicPort) => ({ PrivatePort: 5432, PublicPort, Type: 'tcp' })),
});

const seen = (overrides: Partial<WatchInspect> = {}): WatchInspect => ({
    running: true,
    startedAt: STARTED,
    finishedAt: '0001-01-01T00:00:00Z',
    exitCode: 0,
    oomKilled: false,
    networkMode: 'bridge',
    bindings: [{ hostIp: '', containerPort: 5432, hostPort: 5432, type: 'tcp' }],
    pidAlive: true,
    listening: [5432],
    publishesPorts: true,
    ...overrides,
});

const running = (overrides: Partial<WatchInspect> = {}, published = [5432]) =>
    observe(listed('running', 'Up 19 hours', published), seen(overrides));

/** Run the sweeps in order, a minute apart, and collect every notification. */
function sweeps(
    perSweep: WatchObservation[][],
    prev: WatchSweep | null = { at: NOW - 60, containers: new Map() },
): { sweep: WatchSweep | null; notify: WatchNotice[] } {
    const notify: WatchNotice[] = [];
    let now = NOW;
    for (const observations of perSweep) {
        const plan = planWatch(prev, observations, now);
        notify.push(...plan.notify);
        prev = plan.sweep;
        now += 60;
    }
    return { sweep: prev, notify };
}
const entry = (result: { sweep: WatchSweep | null }) => result.sweep?.containers.get('pg');

describe('container watch', () => {
    it('reads only listening sockets from /proc/net', () => {
        const text = [
            '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode',
            '   0: 00000000:1538 00000000:0000 0A 00000000:00000000 00:00000000 00000000   999        0 1 1',
            '   1: 0100007F:1F90 0100007F:9C40 01 00000000:00000000 00:00000000 00000000   999        0 2 1',
            '   0: 00000000000000000000000000000000:0050 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000 0 0 3 1',
        ].join('\n');
        expect(listeningPorts(text)).toEqual([80, 5432]);
    });

    it('reads Docker times with nine-digit fractions and the zero time', () => {
        expect(timestamp(STARTED)).toBe(Date.UTC(2027, 0, 15, 7) / 1000);
        expect(timestamp('0001-01-01T00:00:00Z')).toBe(0);
        expect(timestamp('')).toBe(0);
    });

    it('reads uptime from running status lines', () => {
        expect(uptimeUpperBound('Up 19 hours (healthy)')).toBe(68400 + 1800);
        expect(uptimeUpperBound('Up About a minute')).toBe(120);
        expect(uptimeUpperBound('Exited (1) 2 hours ago')).toBeNull();
    });

    it('flags a process that exited while Docker says running, and notifies once', () => {
        const dead = running({ finishedAt: '2027-01-15T07:43:00Z', exitCode: 1 });
        const result = sweeps([[dead], [dead]]);
        expect(entry(result)?.processExited).toBe(true);
        expect(result.notify).toEqual([
            {
                subject: 'Container crashed: postgresql16',
                description: "postgresql16's process exited with code 1, but Docker still lists it as running.",
            },
        ]);
    });

    it('flags a running container whose pid is gone, with no exit code', () => {
        const dead = running({ pidAlive: false, listening: null });
        const result = sweeps([[dead], [dead]]);
        expect(entry(result)?.processExited).toBe(true);
        expect(result.notify[0].description).toBe("postgresql16's process exited, but Docker still lists it as running.");
    });

    it('does not read a restart in progress as a dead process', () => {
        const restarting = running({ running: false, pidAlive: false, finishedAt: '2027-01-15T07:43:00Z' });
        expect(planWatch(null, [restarting], NOW).sweep.containers.get('pg')?.processExited).toBe(false);
    });

    it('does not count a FinishedAt from before the boot', () => {
        const skewed = running({ finishedAt: '2027-01-15T07:43:00Z' });
        const bootedAt = Date.UTC(2027, 0, 15, 7, 50) / 1000;
        expect(planWatch(null, [skewed], NOW, bootedAt).sweep.containers.get('pg')?.processExited).toBe(false);
    });

    it('only records on the first sweep, and notifies on the next', () => {
        const dead = running({ finishedAt: '2027-01-15T07:43:00Z', exitCode: 1 });
        const first = planWatch(null, [dead], NOW);
        expect(first.notify).toEqual([]);
        expect(planWatch(first.sweep, [dead], NOW + 60).notify).toHaveLength(1);
    });

    it('notifies when a running container crashes, and not when it stops', () => {
        const crashed = observe(listed('exited', 'Exited (1) 20 seconds ago'), seen({ running: false, exitCode: 1 }));
        expect(sweeps([[running()], [crashed]]).notify.map((n) => n.description)).toEqual(['postgresql16 exited with code 1.']);

        const stopped = observe(listed('exited', 'Exited (143) 20 seconds ago'), seen({ running: false, exitCode: 143 }));
        expect(sweeps([[running()], [stopped]]).notify).toEqual([]);
    });

    it('notifies a kill for memory though 137 is a stop code', () => {
        const killed = observe(listed('exited', 'Exited (137) 20 seconds ago'), seen({ running: false, exitCode: 137, oomKilled: true }));
        expect(sweeps([[running()], [killed]]).notify[0].description).toBe('postgresql16 was killed for running out of memory.');
    });

    it('notifies a crash that started and ended between sweeps', () => {
        const before = observe(listed('exited', 'Exited (0) 3 days ago'), null);
        const brief = observe(
            listed('exited', 'Exited (1) 10 seconds ago'),
            seen({ running: false, exitCode: 1, finishedAt: iso(NOW + 50) }),
        );
        expect(sweeps([[before], [brief]]).notify).toHaveLength(1);
    });

    it('notifies a restart loop once until the container runs cleanly', () => {
        const restarting = observe(listed('restarting', 'Restarting (1) 5 seconds ago'), seen({ running: false, exitCode: 1 }));
        const justStarted = running({ startedAt: iso(NOW + 100) });
        expect(sweeps([[running()], [restarting], [justStarted], [restarting]]).notify).toHaveLength(1);
    });

    it('clears an earlier crash after ten clean minutes', () => {
        const prev: WatchSweep = {
            at: NOW - 60,
            containers: new Map([['pg', { ...planWatch(null, [running()], NOW).sweep.containers.get('pg')!, running: false, alerted: true }]]),
        };
        expect(planWatch(prev, [running()], NOW).sweep.containers.get('pg')?.alerted).toBe(false);
        expect(planWatch(prev, [running({ startedAt: iso(NOW - 120) })], NOW).sweep.containers.get('pg')?.alerted).toBe(true);
    });

    it('flags a port that stops listening on the second miss', () => {
        const closed = running({ listening: [] });
        const once = sweeps([[running()], [closed]]);
        expect(entry(once)?.closedPorts).toEqual([]);
        expect(once.notify).toEqual([]);

        const twice = sweeps([[running()], [closed], [closed], [closed]]);
        expect(entry(twice)?.closedPorts).toEqual([5432]);
        expect(twice.notify.map((n) => n.description)).toEqual(['postgresql16 is running, but nothing listens on port 5432.']);
    });

    it('notifies a flapping port once until it stays quiet', () => {
        const closed = running({ listening: [] });
        const open = running();
        expect(sweeps([[open], [closed], [closed], [open], [closed], [closed]]).notify).toHaveLength(1);

        const quiet = Array.from({ length: 11 }, () => [open]);
        expect(sweeps([[open], [closed], [closed], ...quiet, [closed], [closed]]).notify).toHaveLength(2);
    });

    it('does not flag unpublished ports on a network that never publishes them', () => {
        const macvlan = running({ networkMode: 'br0', publishesPorts: false }, []);
        expect(entry(sweeps([[macvlan], [macvlan]]))?.unpublishedPorts).toEqual([]);
    });

    it('does not flag a port never seen listening', () => {
        const closed = running({ listening: [] });
        const result = sweeps([[closed], [closed], [closed]]);
        expect(entry(result)?.closedPorts).toEqual([]);
        expect(result.notify).toEqual([]);
    });

    it('flags a host port Docker did not publish on the second miss', () => {
        const unpublished = running({}, []);
        const result = sweeps([[unpublished], [unpublished]]);
        expect(entry(result)?.unpublishedPorts).toEqual([5432]);
        expect(result.notify[0].description).toBe('postgresql16 is running, but Docker has not published host port 5432.');
    });

    it('starts the port count over after a restart', () => {
        const closed = running({ listening: [] });
        const restarted = running({ listening: [], startedAt: '2027-01-15T08:00:00Z' });
        expect(entry(sweeps([[running()], [closed], [restarted]]))?.closedPorts).toEqual([]);
    });

    it('does not port-check host-network containers', () => {
        const host = running({ networkMode: 'host', listening: null }, []);
        expect(entry(sweeps([[host], [host]]))?.unpublishedPorts).toEqual([]);
    });

    it('shows findings only for the run the sweep saw, and not from a stale sweep', () => {
        const dead = running({ finishedAt: '2027-01-15T07:43:00Z', exitCode: 1 });
        const sweep = planWatch(null, [dead], NOW - 30).sweep;
        const container = { Id: 'pg', State: 'running', Status: 'Up 19 hours' };

        expect(findingsFor(container, sweep, NOW).processExited).toBe(true);
        expect(findingsFor({ ...container, Status: 'Up 5 seconds' }, sweep, NOW).processExited).toBe(false);
        expect(findingsFor(container, sweep, NOW + 61).processExited).toBe(false);
        expect(findingsFor(container, null, NOW).processExited).toBe(false);
    });
});
