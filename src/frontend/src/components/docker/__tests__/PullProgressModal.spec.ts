import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import PullProgressModal from '../PullProgressModal.vue';
import { useSettingsStore } from '@/stores/settings';

type Emit = (event: string, data: unknown) => void;
type Script = (emit: Emit, opts: { containerIds?: string[]; recreate?: boolean }) => void;

const mocks = vi.hoisted(() => ({
  pull: vi.fn(),
}));

vi.mock('@/backends', () => ({
  useBackend: () => ({ streams: { pull: mocks.pull } }),
}));

/** Each call to `streams.pull` plays the next script, then ends with `done`. */
function playScripts(...scripts: Script[]) {
  const queue = [...scripts];
  mocks.pull.mockImplementation(async (_image: string, opts: Record<string, unknown>, onEvent: Emit) => {
    queue.shift()?.(onEvent, opts);
    onEvent('done', { finished: true });
  });
}

const pulled: Script = (emit) => emit('complete', { message: 'Pull complete' });
const recreated: Script = (emit) => {
  emit('recreating', { container: 'web', message: 'Recreating web...' });
  emit('recreated', { container: 'web', message: 'web updated successfully' });
  emit('complete', { message: 'Pull complete' });
};

let pinia: ReturnType<typeof createPinia>;

async function mountOpen(props: Record<string, unknown> = {}) {
  const wrapper = mount(PullProgressModal, {
    props: { isOpen: false, image: 'nginx:latest', containerName: 'web', containerId: 'id-web', ...props },
    global: { plugins: [pinia], stubs: { Teleport: true } },
  });
  await wrapper.setProps({ isOpen: true });
  await flushPromises();
  return wrapper;
}

const recreateButton = (wrapper: Awaited<ReturnType<typeof mountOpen>>) =>
  wrapper.findAll('button').find((b) => b.text() === 'Recreate');

describe('PullProgressModal', () => {
  beforeEach(() => {
    pinia = createPinia();
    setActivePinia(pinia);
    mocks.pull.mockReset();
  });

  it('offers Recreate after the pull when the setting says to', async () => {
    useSettingsStore().postPullAction = 'pull_and_offer_restart';
    playScripts(pulled);

    const wrapper = await mountOpen();

    expect(recreateButton(wrapper)).toBeDefined();
  });

  it('recreates exactly this container when Recreate is clicked', async () => {
    useSettingsStore().postPullAction = 'pull_and_offer_restart';
    playScripts(pulled, recreated);

    const wrapper = await mountOpen();
    await recreateButton(wrapper)!.trigger('click');
    await flushPromises();

    expect(mocks.pull).toHaveBeenCalledTimes(2);
    expect(mocks.pull.mock.calls[0][1]).toEqual({});
    expect(mocks.pull.mock.calls[1][1]).toEqual({ containerIds: ['id-web'], recreate: true });
    expect(wrapper.text()).toContain('web updated successfully');
    // Offered once: the container now runs the new image.
    expect(recreateButton(wrapper)).toBeUndefined();
  });

  it('does not offer Recreate for pull only', async () => {
    useSettingsStore().postPullAction = 'pull_only';
    playScripts(pulled);

    const wrapper = await mountOpen();

    expect(recreateButton(wrapper)).toBeUndefined();
  });

  it('does not offer Recreate after a force update, which already recreated', async () => {
    useSettingsStore().postPullAction = 'pull_and_offer_restart';
    playScripts(recreated);

    const wrapper = await mountOpen({ force: true });

    expect(recreateButton(wrapper)).toBeUndefined();
  });

  it('does not offer Recreate when the pull failed', async () => {
    useSettingsStore().postPullAction = 'pull_and_offer_restart';
    playScripts((emit) => emit('error', { message: 'Pull failed: manifest unknown' }));

    const wrapper = await mountOpen();

    expect(recreateButton(wrapper)).toBeUndefined();
    expect(wrapper.text()).toContain('manifest unknown');
  });

  it('shows a failed recreate as the outcome, not "Pull complete"', async () => {
    useSettingsStore().postPullAction = 'pull_only';
    playScripts((emit) => {
      emit('recreate_error', { container: 'id-web', message: 'Container id-web was not recreated' });
      emit('complete', { message: 'Pull complete' });
    });

    const wrapper = await mountOpen({ force: true });

    expect(wrapper.text()).toContain('Container id-web was not recreated');
    expect(wrapper.text()).not.toContain('Pull complete');
  });
});
