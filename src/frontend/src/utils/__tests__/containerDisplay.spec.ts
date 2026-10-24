import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  containerPortProblem,
  isRunningContainer,
  containerStatus,
  containerEditUrl,
  containerExitCode,
  containerWebuiUrl,
  isAliveContainer,
  isCrashedContainer,
  isShownWhenHidingStopped,
  openContainerTerminal,
} from '../containerDisplay';

describe('containerStatus', () => {
  it('marks a healthy running container as success', () => {
    expect(containerStatus({ state: 'running', status: 'Up 2 hours (healthy)' }, true)).toEqual({
      halo: 'status-halo-success',
      tooltip: 'Running (healthy)',
      crashed: false,
    });
  });

  it('marks a running container with no health check as info', () => {
    expect(containerStatus({ state: 'running', status: 'Up 2 hours' }, true).halo).toBe('status-halo-info');
  });

  it('ignores health when the setting is off', () => {
    expect(containerStatus({ state: 'running', status: 'Up 2 hours' }, false)).toEqual({
      halo: 'status-halo-success',
      tooltip: 'Running',
      crashed: false,
    });
  });

  it.each([
    ['paused', 'status-halo-warning', 'Paused'],
    ['exited', 'status-halo-error', 'Exited'],
    ['created', 'status-halo-muted', 'Created'],
  ])('maps %s', (state, halo, tooltip) => {
    expect(containerStatus({ state, status: '' }, true)).toEqual({ halo, tooltip, crashed: false });
  });
});

describe('exit codes', () => {
  it('reads the code from an exited or restarting status line', () => {
    expect(containerExitCode({ status: 'Exited (1) 12 hours ago' })).toBe(1);
    expect(containerExitCode({ status: 'Restarting (255) 5 seconds ago' })).toBe(255);
    expect(containerExitCode({ status: 'Up 2 hours' })).toBeNull();
    expect(containerExitCode({ status: '' })).toBeNull();
  });

  it.each([
    ['exited', 'Exited (1) 12 hours ago', true],
    ['restarting', 'Restarting (1) 5 seconds ago', true],
    ['exited', 'Exited (0) 2 days ago', false],
    ['exited', 'Exited (137) 2 days ago', false],
    ['exited', 'Exited (143) 2 days ago', false],
    ['exited', 'Exited (130) 2 days ago', false],
    ['exited', 'Exited (2) 2 days ago', true],
    ['restarting', 'Restarting (137) 3 seconds ago', true],
    ['restarting', 'Restarting (0) 3 seconds ago', true],
    ['dead', 'Dead', true],
    ['running', 'Up 2 hours', false],
    ['exited', '', false],
  ])('%s "%s" crashed: %s', (state, status, crashed) => {
    expect(isCrashedContainer({ state, status })).toBe(crashed);
  });

  it('keeps crashed containers in view while hiding stopped ones', () => {
    expect(isShownWhenHidingStopped({ state: 'running', status: 'Up 2 hours' })).toBe(true);
    expect(isShownWhenHidingStopped({ state: 'exited', status: 'Exited (1) 12 hours ago' })).toBe(true);
    expect(isShownWhenHidingStopped({ state: 'exited', status: 'Exited (0) 2 days ago' })).toBe(false);
    expect(isShownWhenHidingStopped(undefined)).toBe(false);
  });

  it('tells a kill for memory from a timed-out stop, both exit 137', () => {
    const status = 'Exited (137) 1 hour ago';
    expect(isCrashedContainer({ state: 'exited', status, oomKilled: false })).toBe(false);
    expect(containerStatus({ state: 'exited', status, oomKilled: true }, true)).toEqual({
      halo: 'status-halo-error',
      tooltip: 'Crashed (out of memory)',
      crashed: true,
    });
    expect(containerStatus({ state: 'restarting', status: 'Restarting (137) 5 seconds ago', oomKilled: true }, true).tooltip).toBe(
      'Crashing, restarting (out of memory)',
    );
  });

  it('marks a running container whose process exited as crashed', () => {
    const ghost = { state: 'running', status: 'Up 19 hours', processExited: true };
    expect(isCrashedContainer(ghost)).toBe(true);
    expect(isRunningContainer(ghost)).toBe(false);
    expect(isRunningContainer({ state: 'running' })).toBe(true);
    expect(containerStatus(ghost, true)).toEqual({
      halo: 'status-halo-error',
      tooltip: 'Crashed, though Docker still lists it as running',
      crashed: true,
    });
  });

  it('warns about a running container whose ports went dark', () => {
    expect(containerPortProblem({ state: 'running', closedPorts: [5432] })).toBe('nothing listens on port 5432');
    expect(containerPortProblem({ state: 'exited', closedPorts: [5432] })).toBeNull();
    expect(containerPortProblem({ state: 'running', closedPorts: [80, 443], unpublishedPorts: [8080] })).toBe(
      'nothing listens on ports 80, 443; host port 8080 not published',
    );
    expect(containerPortProblem({ state: 'running', closedPorts: [], unpublishedPorts: [] })).toBeNull();
    expect(containerStatus({ state: 'running', status: 'Up 2 hours', unpublishedPorts: [5432] }, true)).toEqual({
      halo: 'status-halo-warning',
      tooltip: 'Running, but host port 5432 not published',
      crashed: false,
    });
  });

  it('marks a dead container as crashed, with no code', () => {
    expect(containerStatus({ state: 'dead', status: 'Dead' }, true)).toEqual({ halo: 'status-halo-error', tooltip: 'Dead', crashed: true });
  });

  it('says crashed, with the code, in the tooltip', () => {
    expect(containerStatus({ state: 'exited', status: 'Exited (1) 12 hours ago' }, true)).toEqual({
      halo: 'status-halo-error',
      tooltip: 'Crashed (exit code 1)',
      crashed: true,
    });
    expect(containerStatus({ state: 'restarting', status: 'Restarting (1) 5 seconds ago' }, true)).toEqual({
      halo: 'status-halo-error',
      tooltip: 'Crashing, restarting (exit code 1)',
      crashed: true,
    });
    expect(containerStatus({ state: 'exited', status: 'Exited (0) 2 days ago' }, true)).toEqual({
      halo: 'status-halo-error',
      tooltip: 'Exited',
      crashed: false,
    });
  });
});

describe('containerEditUrl', () => {
  it('points a dockerman container at its user template', () => {
    expect(containerEditUrl({ managed: 'dockerman', name: 'plex' })).toBe(
      '/Docker/UpdateContainer?xmlTemplate=edit:/boot/config/plugins/dockerMan/templates-user/my-plex.xml',
    );
  });

  it('returns null for an unmanaged container', () => {
    expect(containerEditUrl({ managed: null, name: 'plex' })).toBeNull();
  });
});

describe('containerWebuiUrl', () => {
  it('fills in the host and the mapped public port', () => {
    const ports = [{ PrivatePort: 80, PublicPort: 8080, Type: 'tcp' }];
    expect(containerWebuiUrl({ webui: 'http://[IP]:[PORT:80]/web', ports } as never)).toBe(
      `http://${window.location.hostname}:8080/web`,
    );
  });

  it('keeps the private port when nothing maps it', () => {
    expect(containerWebuiUrl({ webui: 'http://[IP]:[PORT:32400]/', ports: [] })).toBe(`http://${window.location.hostname}:32400/`);
  });

  it('returns null without a WebUI template', () => {
    expect(containerWebuiUrl({ webui: null, ports: [] })).toBeNull();
  });
});

describe('isAliveContainer', () => {
  it.each([
    ['running', true],
    ['paused', true],
    ['exited', false],
    ['created', false],
  ])('%s is %s', (state, alive) => {
    expect(isAliveContainer({ state })).toBe(alive);
  });

  it('treats a missing container as not alive', () => {
    expect(isAliveContainer(undefined)).toBe(false);
  });
});

describe('openContainerTerminal', () => {
  afterEach(() => vi.restoreAllMocks());

  it('falls back to the log terminal URL without a parent openTerminal', () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    openContainerTerminal('my app', 'logs');
    expect(open).toHaveBeenCalledWith('/logterminal/my%20app.log/', '_blank');
  });
});
