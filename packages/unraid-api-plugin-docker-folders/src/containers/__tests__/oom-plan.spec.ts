import { describe, expect, it } from 'vitest';

import { isOomCandidate, planOomChecks } from '../container-list.service.js';
import { statusAgeUpperBound } from '../docker-status.js';

// Mirrors tests/php/DockerClientOomPlanTest.php.
describe('planOomChecks', () => {
    const NOW = 1_000_000_000;
    const listed = (Id: string, State: string, Status: string) => ({ Id, State, Status });
    const plan = (rows: ReturnType<typeof listed>[], cache: Map<string, { oom: boolean; finished: number; failedAt?: number }>) =>
        planOomChecks(rows.filter(isOomCandidate), cache, NOW);

    it('picks containers whose last exit was 137', () => {
        const { inspect, kept } = plan(
            [
                listed('a', 'exited', 'Exited (137) 2 hours ago'),
                listed('b', 'exited', 'Exited (1) 2 hours ago'),
                listed('c', 'running', 'Up 2 hours'),
                listed('d', 'restarting', 'Restarting (137) 5 seconds ago'),
            ],
            new Map(),
        );
        expect(inspect).toEqual(['a', 'd']);
        expect(kept.size).toBe(0);
    });

    it('keeps an answer for the same exit, however old', () => {
        const cache = new Map([['a', { oom: true, finished: NOW - 3 * 86400 }]]);
        const { inspect, kept } = plan([listed('a', 'exited', 'Exited (137) 3 days ago')], cache);
        expect(inspect).toEqual([]);
        expect(kept.get('a')?.oom).toBe(true);
    });

    it('inspects again after a later exit, keeping the old answer meanwhile', () => {
        const cache = new Map([['a', { oom: true, finished: NOW - 600 }]]);
        const { inspect, kept } = plan([listed('a', 'exited', 'Exited (137) 30 seconds ago')], cache);
        expect(inspect).toEqual(['a']);
        expect(kept.get('a')?.oom).toBe(true);
    });

    it('waits before retrying a failed inspect', () => {
        const rows = [listed('a', 'exited', 'Exited (137) 30 seconds ago')];
        expect(plan(rows, new Map([['a', { oom: false, finished: 0, failedAt: NOW - 10 }]])).inspect).toEqual([]);
        expect(plan(rows, new Map([['a', { oom: false, finished: 0, failedAt: NOW - 300 }]])).inspect).toEqual(['a']);
    });

    it('drops containers that ran again or are gone', () => {
        const cache = new Map([
            ['ran', { oom: true, finished: NOW - 600 }],
            ['gone', { oom: true, finished: NOW - 600 }],
        ]);
        const { inspect, kept } = plan([listed('ran', 'running', 'Up 5 seconds')], cache);
        expect(inspect).toEqual([]);
        expect(kept.size).toBe(0);
    });
});

describe('statusAgeUpperBound', () => {
    it.each([
        ['Exited (137) Less than a second ago', 1],
        ['Exited (137) 30 seconds ago', 31],
        ['Exited (137) About a minute ago', 120],
        ['Exited (137) 5 minutes ago', 360],
        ['Exited (137) About an hour ago', 5400],
        ['Exited (137) 2 hours ago', 9000],
        ['Exited (137) 3 days ago', 4 * 86400],
        ['Exited (137) 1 month ago', 2 * 2592000],
        ['Exited (137)', null],
    ])('%s -> %s', (status, bound) => {
        expect(statusAgeUpperBound(status)).toBe(bound);
    });
});
