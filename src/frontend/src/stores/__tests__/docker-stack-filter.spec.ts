import { describe, it, expect, beforeEach } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { useDockerStore } from '@/stores/docker';
import { makeContainer } from '@/test/fixtures';

const PROJECT = 'com.docker.compose.project';

describe('docker store stack filter', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('passes everything with no search and no stack', () => {
    const store = useDockerStore();
    expect(store.isFiltering).toBe(false);
    expect(store.containerPassesFilters(makeContainer({ name: 'plex' }), 'plex')).toBe(true);
  });

  it('passes only containers labelled with the picked stack', () => {
    const store = useDockerStore();
    store.stackFilter = 'arr';
    expect(store.isFiltering).toBe(true);
    expect(store.containerPassesFilters(makeContainer({ name: 'sonarr', labels: { [PROJECT]: 'arr' } }), 'sonarr')).toBe(true);
    expect(store.containerPassesFilters(makeContainer({ name: 'grafana', labels: { [PROJECT]: 'monitoring' } }), 'grafana')).toBe(false);
    expect(store.containerPassesFilters(makeContainer({ name: 'plex' }), 'plex')).toBe(false);
  });

  it('never matches a stale association to a stack', () => {
    const store = useDockerStore();
    store.stackFilter = 'arr';
    expect(store.containerPassesFilters(undefined, 'sonarr')).toBe(false);
  });

  it('applies the search and the stack together', () => {
    const store = useDockerStore();
    store.stackFilter = 'arr';
    store.searchQuery = 'son';
    expect(store.containerPassesFilters(makeContainer({ name: 'sonarr', labels: { [PROJECT]: 'arr' } }), 'sonarr')).toBe(true);
    expect(store.containerPassesFilters(makeContainer({ name: 'radarr', labels: { [PROJECT]: 'arr' } }), 'radarr')).toBe(false);
  });

  it('matches a stale association by name when only searching', () => {
    const store = useDockerStore();
    store.searchQuery = 'son';
    expect(store.containerPassesFilters(undefined, 'sonarr')).toBe(true);
    expect(store.containerPassesFilters(undefined, 'radarr')).toBe(false);
  });

  it('keeps the picked stack\'s own folder only while the stack has no containers', () => {
    const store = useDockerStore();
    store.stackFilter = 'arr';
    expect(store.stackFilterKeepsDownStackFolder('arr')).toBe(true);
    expect(store.stackFilterKeepsDownStackFolder('other')).toBe(false);
    store.containers = [makeContainer({ name: 'sonarr', labels: { [PROJECT]: 'arr' } })];
    expect(store.stackFilterKeepsDownStackFolder('arr')).toBe(false);
    store.stackFilter = null;
    expect(store.stackFilterKeepsDownStackFolder('arr')).toBe(false);
  });
});
