import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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
    expect(mocks.pull.mock.calls[1][1]).toEqual({ containerIds: ['id-web'], recreateOnly: true });
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

  it('applies a pulled update with a recreate and no pull', async () => {
    useSettingsStore().postPullAction = 'pull_only';
    playScripts(recreated);

    const wrapper = await mountOpen({ recreateOnly: true });

    expect(mocks.pull).toHaveBeenCalledTimes(1);
    expect(mocks.pull.mock.calls[0][1]).toEqual({ containerIds: ['id-web'], recreateOnly: true });
    expect(wrapper.text()).toContain('Apply Update');
    expect(wrapper.text()).toContain('web updated successfully');
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

/**
 * On Unraid the modal is drawn by the parent page, and only this path is what
 * users see. Issue #20 was an offer that existed only in the dev-server modal.
 */
describe('PullProgressModal – parent-window (iframe) path', () => {
  let parentPostMessage: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    pinia = createPinia();
    setActivePinia(pinia);
    mocks.pull.mockReset();
    parentPostMessage = vi.fn();
    Object.defineProperty(window, 'parent', {
      value: { postMessage: parentPostMessage },
      configurable: true,
      writable: true,
    });
  });

  afterEach(() => {
    Object.defineProperty(window, 'parent', { value: window, configurable: true, writable: true });
  });

  const messages = () => parentPostMessage.mock.calls.map((c) => c[0]);

  /** The action ids of the newest patch that set actions. */
  function latestActions(): string[] {
    const patches = messages().filter((m) => m?.type === 'docker-folders-modal-update' && m.patch?.actions);
    const actions = patches[patches.length - 1].patch.actions as { id: string; hidden?: boolean; variant?: string }[];
    return actions.filter((a) => !a.hidden).map((a) => (a.variant === 'primary' ? `${a.id}:primary` : a.id));
  }

  async function hostPresses(actionId: string) {
    const open = messages().find((m) => m?.type === 'docker-folders-modal' && m.open);
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { type: 'docker-folders-modal-action', id: open.modal.id, actionId, values: {} },
      }),
    );
    await flushPromises();
  }

  it('offers Recreate as a primary action after the pull', async () => {
    useSettingsStore().postPullAction = 'pull_and_offer_restart';
    playScripts(pulled);

    await mountOpen();

    expect(latestActions()).toEqual(['close', 'recreate:primary']);
  });

  it('offers only Close for pull only', async () => {
    useSettingsStore().postPullAction = 'pull_only';
    playScripts(pulled);

    await mountOpen();

    expect(latestActions()).toEqual(['close']);
  });

  it('recreates when the parent sends the recreate action, then offers only Close', async () => {
    useSettingsStore().postPullAction = 'pull_and_offer_restart';
    playScripts(pulled, recreated);

    await mountOpen();
    await hostPresses('recreate');

    expect(mocks.pull.mock.calls[1][1]).toEqual({ containerIds: ['id-web'], recreateOnly: true });
    expect(latestActions()).toEqual(['close']);
  });
});
