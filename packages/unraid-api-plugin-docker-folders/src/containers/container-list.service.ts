import { Inject, Injectable, Logger } from '@nestjs/common';

import type { ContainerFacts } from './container-facts.js';
import { extractFacts } from './container-facts.js';
import type {
    DockerFoldersContainer,
    DockerFoldersHostPort,
    DockerFoldersLabel,
    DockerFoldersMount,
    DockerFoldersNetwork,
    DockerFoldersPort,
} from './container.model.js';
import { DOCKER_CLIENT_TOKEN, type DockerClient, type DockerListContainer } from './docker-client.js';
import { isImageOutdated, resolveImageTag } from '../updates/docker-refs.js';
import { readAutostartMap } from './unraid-templates.js';
import { statusAgeUpperBound } from './docker-status.js';
import { ContainerWatchService } from './container-watch.service.js';
import { nowSeconds } from '../util/time.js';

/**
 * The container list, ported from `DockerClient::listContainers`.
 *
 * Docker's own list endpoint is not enough on its own, which is the whole
 * reason this class is more than one call:
 *
 * - It carries no `HostConfig` and no `Config`, so the published port
 *   bindings and everything the security advisor reads have to come from
 *   `docker inspect`, per container.
 * - It reports an image as a bare `sha256:` digest once the tag it was pulled
 *   under has moved to a newer image, which happens to every container whose
 *   image was ever updated. Unraid's template still records what the user
 *   chose.
 * - It knows nothing about autostart, which lives on the flash drive.
 */

/**
 * Facts are cached by container id and never invalidated, because every field
 * in them is immutable for that id: `docker update` cannot change any of them,
 * and editing one through Unraid's template recreates the container with a new
 * id.
 *
 * In memory rather than in a file, which is where the PHP has to keep it. The
 * API is one long-running process, so a Map survives between requests and
 * PHP-FPM's does not. That also keeps the plugin off
 * `/tmp/unraid-docker-container-facts-v4.json`, which PHP rewrites on its own
 * list calls - two writers on one JSON file, with no locking on either side,
 * would eventually truncate it for both.
 */
interface CachedFacts extends ContainerFacts {
    /** `Config.User` of the image, so `user` can be read as an override. */
    imageUser: string;
    /** Which image to ask for that, recorded while the container was inspected. */
    imageId: string;
    /**
     * `Config.Image`, the reference the container was created from. Fixed for
     * the life of the id, unlike the list's `Image`, which turns into a bare
     * `sha256:` id once that reference moves to a newer image.
     */
    configImage: string;
}

/**
 * `State.OOMKilled` for containers whose last exit was 137, ported from
 * `DockerClient::getOomKilledMap`. That code is both a `docker stop` that
 * timed out and a kill for running out of memory, and only inspect tells them
 * apart. Each answer is tied to the exit it describes (`State.FinishedAt`):
 * the list's "Exited (137) 5 minutes ago" says when the last exit was, and an
 * exit newer than the saved one is inspected again. So each exit costs one
 * inspect, whatever the server's size.
 */
interface OomAnswer {
    oom: boolean;
    /** FinishedAt in epoch seconds, 0 when unknown. */
    finished: number;
    /** Set when the inspect failed, so it is retried after OOM_RETRY_SECONDS. */
    failedAt?: number;
}

const OOM_RETRY_SECONDS = 300;

type ListedForOom = Pick<DockerListContainer, 'Id' | 'State' | 'Status'>;

/** Exited, or restarting, after an exit with 137. */
export function isOomCandidate(container: ListedForOom): boolean {
    return (
        (container.State === 'exited' || container.State === 'restarting') &&
        /^(?:Exited|Restarting) \(137\)/.test(container.Status ?? '')
    );
}

/**
 * Which candidates to inspect, and the answers still worth keeping: a
 * container gone, or seen in another state, has nothing to say. See
 * `DockerClient::planOomChecks` for the rule, which this mirrors.
 */
export function planOomChecks(
    candidates: ListedForOom[],
    cache: ReadonlyMap<string, OomAnswer>,
    now: number,
): { inspect: string[]; kept: Map<string, OomAnswer> } {
    const inspect: string[] = [];
    const kept = new Map<string, OomAnswer>();
    for (const container of candidates) {
        const entry = cache.get(container.Id);
        if (!entry) {
            inspect.push(container.Id);
            continue;
        }
        kept.set(container.Id, entry);
        if (entry.failedAt !== undefined) {
            if (now - entry.failedAt >= OOM_RETRY_SECONDS) inspect.push(container.Id);
            continue;
        }
        const maxAge = statusAgeUpperBound(container.Status ?? '');
        if (maxAge !== null && entry.finished < now - maxAge - 60) inspect.push(container.Id);
    }
    return { inspect, kept };
}

@Injectable()
export class ContainerListService {
    private readonly logger = new Logger(ContainerListService.name);
    private readonly facts = new Map<string, CachedFacts>();
    private oom = new Map<string, OomAnswer>();

    constructor(
        @Inject(DOCKER_CLIENT_TOKEN) private readonly docker: DockerClient,
        private readonly watch: ContainerWatchService,
    ) {}

    async listContainers(): Promise<DockerFoldersContainer[]> {
        const raw = await this.docker.listContainers({ all: true });

        const autostart = readAutostartMap();
        const [facts, oom] = await Promise.all([this.factsFor(raw.map((container) => container.Id)), this.oomFor(raw)]);

        const now = nowSeconds();
        return raw.map((container) => {
            const name = stripLeadingSlash(container.Names?.[0] ?? '');
            const labels = container.Labels ?? {};
            const known = facts.get(container.Id);
            const listImage = container.Image ?? '';
            const configImage = known?.configImage ?? '';

            return {
                id: container.Id,
                name,
                image: resolveImageTag(listImage, name, configImage),
                imageOutdated: isImageOutdated(listImage, configImage),
                state: container.State ?? '',
                status: container.Status ?? '',
                command: container.Command ?? '',
                created: container.Created ?? 0,
                ports: mapPorts(container),
                mounts: mapMounts(container),
                networkSettings: mapNetworks(container),
                networkMode: container.HostConfig?.NetworkMode ?? 'bridge',
                labels: mapLabels(labels),
                icon: labels['net.unraid.docker.icon'] ?? null,
                managed: labels['net.unraid.docker.managed'] ?? null,
                webui: labels['net.unraid.docker.webui'] ?? null,
                autostart: autostart.get(name)?.autostart ?? false,
                autostartDelay: autostart.get(name)?.autostartDelay ?? 0,
                hostPorts: known?.ports ?? ([] as DockerFoldersHostPort[]),
                privileged: known?.privileged ?? false,
                capAdd: known?.capAdd ?? [],
                exposedPorts: known?.exposedPorts ?? [],
                user: known?.user ?? '',
                imageUser: known?.imageUser ?? '',
                puid: known?.puid ?? '',
                pgid: known?.pgid ?? '',
                umask: known?.umask ?? '',
                oomKilled: oom.get(container.Id)?.oom ?? false,
                ...this.watch.findings(container, now),
            };
        });
    }

    private async oomFor(raw: DockerListContainer[]): Promise<Map<string, OomAnswer>> {
        const now = nowSeconds();
        const { inspect, kept } = planOomChecks(raw.filter(isOomCandidate), this.oom, now);
        await Promise.all(
            inspect.map(async (id) => {
                try {
                    const state = (await this.docker.getContainer(id).inspect()).State;
                    const finished = Math.floor(Date.parse(state?.FinishedAt ?? '') / 1000);
                    kept.set(id, { oom: Boolean(state?.OOMKilled), finished: finished > 0 ? finished : 0 });
                } catch (error) {
                    // Keep the old answer, and wait OOM_RETRY_SECONDS before trying again.
                    kept.set(id, { oom: kept.get(id)?.oom ?? false, finished: 0, failedAt: now });
                    this.logger.warn(`Could not inspect container ${id}: ${String(error)}`);
                }
            }),
        );
        this.oom = kept;
        return kept;
    }

    /**
     * Inspect only the ids that are not cached yet, in parallel.
     *
     * On a settled server this inspects nothing at all. It is only a container
     * that was just created, or just recreated by an update, that costs a
     * round trip.
     */
    private async factsFor(ids: string[]): Promise<Map<string, CachedFacts>> {
        const missing = ids.filter((id) => !this.facts.has(id));

        await Promise.all(missing.map((id) => this.inspectInto(id)));
        await this.fillImageUsers(missing);

        // Drop containers that no longer exist, so a server that recreates
        // containers often does not grow this map without bound.
        const live = new Set(ids);
        for (const id of this.facts.keys()) {
            if (!live.has(id)) this.facts.delete(id);
        }

        return this.facts;
    }

    private async inspectInto(id: string): Promise<void> {
        try {
            const inspect = await this.docker.getContainer(id).inspect();
            this.facts.set(id, {
                ...extractFacts(inspect),
                imageUser: '',
                imageId: asString(inspect.Image),
                configImage: asString(inspect.Config?.Image),
            });
        } catch (error) {
            // One container that cannot be inspected must not empty the whole
            // list. It simply reports the defaults, and is inspected again on
            // the next call because nothing was cached for it.
            this.logger.warn(`Could not inspect container ${id}: ${String(error)}`);
        }
    }

    /**
     * Fill in the image's own user for the containers that declare one.
     *
     * Only those: `user` is empty on most containers, and without a value
     * there is nothing to compare against. Deduplicated by image, because a
     * stack usually runs several containers from one.
     */
    private async fillImageUsers(ids: string[]): Promise<void> {
        const wanted = new Map<string, string[]>();
        for (const id of ids) {
            const facts = this.facts.get(id);
            if (facts === undefined || facts.user === '') continue;

            if (facts.imageId === '') continue;
            wanted.set(facts.imageId, [...(wanted.get(facts.imageId) ?? []), id]);
        }

        await Promise.all(
            [...wanted].map(async ([imageId, containerIds]) => {
                let imageUser = '';
                try {
                    const inspect = await this.docker.getImage(imageId).inspect();
                    imageUser = asString(inspect.Config?.User);
                } catch (error) {
                    this.logger.warn(`Could not inspect image ${imageId}: ${String(error)}`);
                    return;
                }
                for (const id of containerIds) {
                    const facts = this.facts.get(id);
                    if (facts !== undefined) facts.imageUser = imageUser;
                }
            })
        );
    }
}

function stripLeadingSlash(name: string): string {
    return name.startsWith('/') ? name.slice(1) : name;
}

function mapPorts(container: DockerListContainer): DockerFoldersPort[] {
    return (container.Ports ?? []).map((port) => ({
        ip: port.IP ?? null,
        privatePort: port.PrivatePort ?? 0,
        publicPort: port.PublicPort ?? null,
        type: port.Type ?? 'tcp',
    }));
}

function mapMounts(container: DockerListContainer): DockerFoldersMount[] {
    return (container.Mounts ?? []).map((mount) => ({
        type: mount.Type ?? '',
        source: mount.Source ?? '',
        destination: mount.Destination ?? '',
        rw: mount.RW !== false,
    }));
}

function mapNetworks(container: DockerListContainer): DockerFoldersNetwork[] {
    const networks = container.NetworkSettings?.Networks ?? {};
    return Object.entries(networks).map(([name, network]) => ({
        name,
        ipAddress: asString(network?.IPAddress),
    }));
}

function mapLabels(labels: Record<string, string>): DockerFoldersLabel[] {
    return Object.entries(labels).map(([key, value]) => ({ key, value: String(value) }));
}

function asString(value: unknown): string {
    return value === undefined || value === null ? '' : String(value);
}
