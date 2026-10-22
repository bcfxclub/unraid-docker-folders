import { describe, expect, it } from 'vitest';

import { isImageOutdated, isTagReference, resolveImageTag, selectRecreateTargets } from '../docker-refs.js';

const SHA = `sha256:${'a'.repeat(64)}`;

describe('isTagReference', () => {
    it('accepts a tag, with or without a registry port', () => {
        expect(isTagReference('linuxserver/plex:latest')).toBe(true);
        expect(isTagReference('nginx')).toBe(true);
        expect(isTagReference('registry:5000/foo/bar:v2')).toBe(true);
    });

    it('rejects an empty reference, a bare id, and a digest pin', () => {
        expect(isTagReference('')).toBe(false);
        expect(isTagReference(SHA)).toBe(false);
        expect(isTagReference(`foo/bar@${SHA}`)).toBe(false);
    });
});

describe('isImageOutdated', () => {
    it('is true when Docker lists a tagged container under its image id', () => {
        expect(isImageOutdated(SHA, 'nginx:latest')).toBe(true);
    });

    it('is false while the list still shows the tag', () => {
        expect(isImageOutdated('nginx:latest', 'nginx:latest')).toBe(false);
    });

    it('is false for a container created from an id or a digest', () => {
        expect(isImageOutdated(SHA, SHA)).toBe(false);
        expect(isImageOutdated(SHA, `nginx@${SHA}`)).toBe(false);
        expect(isImageOutdated(SHA, '')).toBe(false);
    });
});

describe('resolveImageTag', () => {
    it('falls back to Config.Image when there is no template', () => {
        expect(resolveImageTag(SHA, 'no-such-template', 'nginx:latest')).toBe('nginx:latest');
    });

    it('keeps the id when Config.Image is not a tag either', () => {
        expect(resolveImageTag(SHA, 'no-such-template', SHA)).toBe(SHA);
    });
});

describe('selectRecreateTargets', () => {
    const containers = [
        { id: 'a', name: 'web', image: 'nginx:latest' },
        { id: 'b', name: 'web2', image: 'nginx:latest' },
        { id: 'c', name: 'db', image: 'postgres:16' },
    ];

    it('picks every container on the image without ids', () => {
        expect(selectRecreateTargets(containers, 'nginx:latest', null)).toEqual({
            targets: [containers[0], containers[1]],
            missing: [],
        });
    });

    it('picks only the requested ids, and reports one on another image', () => {
        expect(selectRecreateTargets(containers, 'nginx:latest', new Set(['b', 'c']))).toEqual({
            targets: [containers[1]],
            missing: ['c'],
        });
    });

    it('reports an id that no longer exists', () => {
        expect(selectRecreateTargets(containers, 'nginx:latest', new Set(['gone']))).toEqual({
            targets: [],
            missing: ['gone'],
        });
    });
});
