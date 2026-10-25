import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { useStackActionConfirm } from '../useStackActionConfirm';
import { useSettingsStore } from '@/stores/settings';

describe('useStackActionConfirm', () => {
  let run: ReturnType<typeof vi.fn<(project: string) => void>>;

  beforeEach(() => {
    setActivePinia(createPinia());
    run = vi.fn();
    useSettingsStore().setConfirmStackAction = vi.fn();
  });

  it('asks first while the setting is on, and runs only on confirm', () => {
    const { pending, request, confirm } = useStackActionConfirm('down', run);
    request('arr');
    expect(pending.value).toEqual({ action: 'down', project: 'arr' });
    expect(run).not.toHaveBeenCalled();
    confirm(false);
    expect(run).toHaveBeenCalledWith('arr');
    expect(pending.value).toBeNull();
    expect(useSettingsStore().setConfirmStackAction).not.toHaveBeenCalled();
  });

  it('turns the question off when confirmed with "don\'t ask again"', () => {
    const { request, confirm } = useStackActionConfirm('recompose', run);
    request('arr');
    confirm(true);
    expect(useSettingsStore().setConfirmStackAction).toHaveBeenCalledWith('recompose', false);
    expect(run).toHaveBeenCalledWith('arr');
  });

  it('runs at once when that action\'s question is off', () => {
    useSettingsStore().confirmStackActions.down = false;
    const down = useStackActionConfirm('down', run);
    down.request('arr');
    expect(run).toHaveBeenCalledWith('arr');
    expect(down.pending.value).toBeNull();
    // Recompose still asks.
    const recompose = useStackActionConfirm('recompose', run);
    recompose.request('arr');
    expect(recompose.pending.value).toEqual({ action: 'recompose', project: 'arr' });
  });

  it('cancel drops the action without running it', () => {
    const { pending, request, cancel } = useStackActionConfirm('down', run);
    request('arr');
    cancel();
    expect(pending.value).toBeNull();
    expect(run).not.toHaveBeenCalled();
  });
});
