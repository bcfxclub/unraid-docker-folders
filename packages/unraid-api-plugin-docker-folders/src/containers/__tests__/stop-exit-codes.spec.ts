import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { STOP_EXIT_CODES } from '../container-watch.js';

const repo = fileURLToPath(new URL('../../../../../', import.meta.url));
const numbers = (text: string) => text.split(',').map((n) => Number(n.trim())).sort((a, b) => a - b);

/**
 * Which exit codes count as a stop, rather than a crash, is written three
 * times: the frontend marks crashes, and each backend's container watch
 * notifies on them. One set drifting from the others would mark a crash the
 * notifications stay quiet about, or the reverse.
 */
describe('STOP_EXIT_CODES', () => {
    const plugin = [...STOP_EXIT_CODES].sort((a, b) => a - b);

    it('matches the PHP container watch', () => {
        const php = readFileSync(
            `${repo}src/backend/usr/local/emhttp/plugins/unraid-docker-folders-modern/classes/ContainerWatch.php`,
            'utf8',
        );
        const match = /const STOP_EXIT_CODES = \[([^\]]+)\]/.exec(php);
        expect(match).not.toBeNull();
        expect(numbers(match![1])).toEqual(plugin);
    });

    it('matches the frontend', () => {
        const ts = readFileSync(`${repo}src/frontend/src/utils/containerDisplay.ts`, 'utf8');
        const match = /const STOP_EXIT_CODES = new Set\(\[([^\]]+)\]\)/.exec(ts);
        expect(match).not.toBeNull();
        expect(numbers(match![1])).toEqual(plugin);
    });
});
