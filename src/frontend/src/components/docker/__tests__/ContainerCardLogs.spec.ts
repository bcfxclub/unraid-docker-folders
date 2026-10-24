import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia, type Pinia } from 'pinia';
import ContainerCard from '../ContainerCard.vue';
import { useSettingsStore } from '@/stores/settings';
import { setActiveBackend } from '@/backends';
import { phpBackend } from '@/backends/php';
import type { Backend, ErrorBody, LiveHandlers } from '@/backends/types';
import { makeContainer } from '@/test/fixtures';

type LogHandlers = LiveHandlers<ErrorBody & { logs?: string }>;

describe('ContainerCard inline logs with a live backend', () => {
  let pinia: Pinia;
  let streams: { name: string; handlers: LogHandlers; close: ReturnType<typeof vi.fn> }[];
  let logs: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    pinia = createPinia();
    setActivePinia(pinia);
    streams = [];
    logs = vi.fn(async () => ({ ok: true, status: 200, data: { logs: 'polled' } }));

    const live: NonNullable<Backend['live']> = {
      stats: () => () => undefined,
      logs: (name, _tail, handlers) => {
        const close = vi.fn();
        streams.push({ name, handlers, close });
        return close;
      },
      composeLogs: () => () => undefined,
    };
    setActiveBackend({
      ...phpBackend,
      containers: { ...phpBackend.containers, logs },
      stats: { get: async () => ({ ok: true, status: 200, data: { stats: {} } }) },
      live,
    } as Backend);
  });

  afterEach(() => {
    setActiveBackend(phpBackend);
    vi.useRealTimers();
  });

  async function mountExpanded() {
    const settings = useSettingsStore();
    settings.showInlineLogs = true;
    settings.logRefreshInterval = 10;
    const wrapper = mount(ContainerCard, {
      props: { container: makeContainer({ state: 'running' }), view: 'grid' as const },
      global: { plugins: [pinia], stubs: { Teleport: true } },
    });
    await wrapper.find('h3').trigger('click');
    await flushPromises();
    return wrapper;
  }

  it('streams instead of polling, and puts new lines on top', async () => {
    const wrapper = await mountExpanded();

    expect(streams).toHaveLength(1);
    streams[0].handlers.onData({ logs: 'two\none', error: false });
    await flushPromises();
    streams[0].handlers.onData({ logs: 'four\nthree', error: false });
    await flushPromises();

    const text = wrapper.find('.log-pane').text();
    expect(text.indexOf('four')).toBeLessThan(text.indexOf('two'));
    await vi.advanceTimersByTimeAsync(30000);
    expect(logs).not.toHaveBeenCalled();
  });

  it('polls after the stream drops, then streams again', async () => {
    await mountExpanded();

    streams[0].handlers.onEnd('Live update connection closed: code 1006');
    await flushPromises();
    expect(logs).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(10000);
    expect(logs).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(5000);
    expect(streams).toHaveLength(2);
  });

  it('fetches once and does not stream when the refresh interval is 0', async () => {
    const settings = useSettingsStore();
    settings.logRefreshInterval = 0;
    const wrapper = mount(ContainerCard, {
      props: { container: makeContainer({ state: 'running' }), view: 'grid' as const },
      global: { plugins: [pinia], stubs: { Teleport: true } },
    });
    settings.showInlineLogs = true;
    await wrapper.find('h3').trigger('click');
    await flushPromises();

    expect(streams).toHaveLength(0);
    expect(logs).toHaveBeenCalledTimes(1);
  });

  async function mountStopped(container: Parameters<typeof makeContainer>[0]) {
    const settings = useSettingsStore();
    settings.showInlineLogs = false;
    settings.logRefreshInterval = 10;
    const wrapper = mount(ContainerCard, {
      props: { container: makeContainer(container), view: 'grid' as const },
      global: { plugins: [pinia], stubs: { Teleport: true } },
    });
    await wrapper.find('h3').trigger('click');
    await flushPromises();
    return wrapper;
  }

  it('shows a stopped container its last 200 lines once, with the setting off', async () => {
    const wrapper = await mountStopped({ state: 'exited', status: 'Exited (1) 22 minutes ago' });

    expect(wrapper.find('.log-pane').text()).toContain('polled');
    expect(logs).toHaveBeenCalledWith(expect.any(String), 200);
    expect(streams).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(30000);
    expect(logs).toHaveBeenCalledTimes(1);
  });

  it('treats a running container whose process exited as stopped', async () => {
    await mountStopped({ state: 'running', processExited: true });

    expect(logs).toHaveBeenCalledWith(expect.any(String), 200);
    expect(streams).toHaveLength(0);
  });

  it('keeps the pane when a stopped container has no logs', async () => {
    logs.mockResolvedValue({ ok: true, status: 200, data: { logs: '' } });
    const wrapper = await mountStopped({ state: 'exited' });

    expect(wrapper.find('.log-pane').text()).toContain('No logs available.');
  });

  it('switches to the one-time stopped tail when the container stops with the pane open', async () => {
    const wrapper = await mountExpanded();
    expect(streams).toHaveLength(1);

    await wrapper.setProps({ container: makeContainer({ state: 'exited' }) });
    await flushPromises();

    expect(streams[0].close).toHaveBeenCalled();
    expect(logs).toHaveBeenCalledTimes(1);
    expect(logs).toHaveBeenCalledWith(expect.any(String), 200);
    await vi.advanceTimersByTimeAsync(30000);
    expect(logs).toHaveBeenCalledTimes(1);
    expect(streams).toHaveLength(1);
  });

  it('fetches once when a stop also opens the pane', async () => {
    const wrapper = await mountStopped({ state: 'running' });
    expect(logs).not.toHaveBeenCalled();

    await wrapper.setProps({ container: makeContainer({ state: 'exited' }) });
    await flushPromises();

    expect(logs).toHaveBeenCalledTimes(1);
  });

  it('streams again when a stopped container starts with the setting on', async () => {
    const settings = useSettingsStore();
    const wrapper = await mountStopped({ state: 'exited' });
    settings.showInlineLogs = true;

    await wrapper.setProps({ container: makeContainer({ state: 'running' }) });
    await flushPromises();

    expect(streams).toHaveLength(1);
  });

  it('keeps a restarting container live', async () => {
    const settings = useSettingsStore();
    settings.showInlineLogs = true;
    settings.logRefreshInterval = 10;
    const wrapper = mount(ContainerCard, {
      props: { container: makeContainer({ state: 'restarting' }), view: 'grid' as const },
      global: { plugins: [pinia], stubs: { Teleport: true } },
    });
    await wrapper.find('h3').trigger('click');
    await flushPromises();

    expect(streams).toHaveLength(1);
  });

  it('drops a poll that answers after the stopped tail', async () => {
    const settings = useSettingsStore();
    settings.logRefreshInterval = 0;
    let answerPoll!: (v: unknown) => void;
    logs
      .mockImplementationOnce(() => new Promise((r) => { answerPoll = r; }))
      .mockResolvedValueOnce({ ok: true, status: 200, data: { logs: 'crash output' } });
    const wrapper = mount(ContainerCard, {
      props: { container: makeContainer({ state: 'running' }), view: 'grid' as const },
      global: { plugins: [pinia], stubs: { Teleport: true } },
    });
    settings.showInlineLogs = true;
    await wrapper.find('h3').trigger('click');
    await flushPromises();

    await wrapper.setProps({ container: makeContainer({ state: 'exited' }) });
    await flushPromises();
    answerPoll({ ok: true, status: 200, data: { logs: 'before the crash' } });
    await flushPromises();

    const text = wrapper.find('.log-pane').text();
    expect(text).toContain('crash output');
    expect(text).not.toContain('before the crash');
  });

  it('closes the stream when the card collapses', async () => {
    const wrapper = await mountExpanded();

    await wrapper.find('h3').trigger('click');
    await flushPromises();

    expect(streams[0].close).toHaveBeenCalled();
  });
});
