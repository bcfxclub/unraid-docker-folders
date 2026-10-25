import { Inject, Injectable, Logger } from '@nestjs/common';
import { existsSync, readFileSync } from 'node:fs';
import { uptime } from 'node:os';

import { sendUnraidNotification } from '../schedules/schedule-notifications.js';
import { nowSeconds } from '../util/time.js';
import { publishesPorts } from './adopt-builder.js';
import {
    checksPorts,
    findingsFor,
    fromInspect,
    idsToInspect,
    listeningPorts,
    observe,
    planWatch,
    WATCH_STALE_SECONDS,
    type WatchFindings,
    type WatchInspect,
    type WatchSweep,
} from './container-watch.js';
import {
    DOCKER_CLIENT_TOKEN,
    DOCKER_SOCKET_PATH,
    type DockerClient,
    type DockerInspectInfo,
    type DockerListContainer,
} from './docker-client.js';
import type { DockerFoldersExtraDockerClient } from './extras-docker-client.js';

/** A second sweep in the same minute skips, as `ContainerWatch::MIN_INTERVAL`. */
const MIN_INTERVAL = 30;
/** Inspects in flight at once. The sweep is background work inside the API's process. */
const INSPECT_CONCURRENCY = 8;

type WatchDockerClient = DockerClient & Pick<DockerFoldersExtraDockerClient, 'getNetwork'>;

/**
 * The container watch for GraphQL mode, ported from `ContainerWatch::run`.
 * SchedulerService drives it once a minute while this runner owns the
 * `container-watch` job, and ContainerListService reads what it found.
 *
 * The sweep lives in memory rather than in PHP's state file, so the two
 * backends never write one file. A handover starts over: the first sweep
 * only records.
 */
@Injectable()
export class ContainerWatchService {
    private readonly logger = new Logger(ContainerWatchService.name);
    private sweep: WatchSweep | null = null;
    private sweeping = false;

    constructor(@Inject(DOCKER_CLIENT_TOKEN) private readonly docker: WatchDockerClient) {}

    async run(now = nowSeconds()): Promise<void> {
        if (this.sweeping || !existsSync(DOCKER_SOCKET_PATH)) return;
        const prev = this.sweep !== null && now - this.sweep.at <= WATCH_STALE_SECONDS ? this.sweep : null;
        if (prev !== null && now - prev.at < MIN_INTERVAL) return;

        this.sweeping = true;
        try {
            const listed = await this.docker.listContainers({ all: true });
            const wanted = new Set(idsToInspect(listed, prev));
            const drivers = new Map<string, Promise<string>>();
            const seen = new Map<string, WatchInspect | null>();
            const queue = listed.filter((container) => wanted.has(container.Id));
            await Promise.all(
                Array.from({ length: Math.min(INSPECT_CONCURRENCY, queue.length) }, async () => {
                    for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
                        seen.set(next.Id, await this.inspect(next, drivers));
                    }
                })
            );
            const observations = listed.map((container) => observe(container, seen.get(container.Id) ?? null));
            const { sweep, notify } = planWatch(prev, observations, now, Math.floor(now - uptime()));
            this.sweep = sweep;
            for (const text of notify) sendUnraidNotification(text, 'warning');
        } catch (error) {
            // A list that failed is not "every container is gone": keep the
            // last sweep, which goes stale and stops showing on its own.
            this.logger.warn(`Container watch failed: ${String(error)}`);
        } finally {
            this.sweeping = false;
        }
    }

    /** What the sweep found on one listed container. */
    findings(container: DockerListContainer, now = nowSeconds()): WatchFindings {
        return findingsFor(container, this.sweep, now);
    }

    private async inspect(container: DockerListContainer, drivers: Map<string, Promise<string>>): Promise<WatchInspect | null> {
        let raw: DockerInspectInfo;
        try {
            raw = await this.docker.getContainer(container.Id).inspect();
        } catch {
            return null;
        }
        const seen = fromInspect(raw);
        const pid = Number(raw.State?.Pid ?? 0);
        const pidAlive = pid > 0 && this.procExists(pid);
        const result: WatchInspect = { ...seen, pidAlive, listening: null, publishesPorts: false };
        if (!seen.running || !checksPorts(seen.networkMode) || seen.bindings.length === 0) return result;

        const mode = seen.networkMode === 'default' ? 'bridge' : seen.networkMode;
        if (!drivers.has(mode)) drivers.set(mode, this.networkDriver(mode));
        const driver = await drivers.get(mode)!;
        // An unknown driver says nothing either way, so it is not checked.
        result.publishesPorts = driver !== '' && publishesPorts(mode, driver);

        if (pidAlive && seen.bindings.some((binding) => binding.type === 'tcp')) {
            const text = ['tcp', 'tcp6'].map((file) => this.readProc(`/proc/${pid}/net/${file}`)).join('');
            result.listening = text === '' ? null : listeningPorts(text);
        }
        return result;
    }

    private async networkDriver(name: string): Promise<string> {
        try {
            return (await this.docker.getNetwork(name).inspect()).Driver ?? '';
        } catch {
            return '';
        }
    }

    /** Protected so the tests can stand in for /proc. */
    protected procExists(pid: number): boolean {
        return existsSync(`/proc/${pid}`);
    }

    protected readProc(path: string): string {
        try {
            return readFileSync(path, 'utf8');
        } catch {
            return '';
        }
    }
}
