import { ref } from 'vue';
import { useSettingsStore, type DestructiveStackAction } from '@/stores/settings';

export interface PendingStackAction {
  action: DestructiveStackAction;
  project: string;
}

/**
 * Ask before a stack action that deletes containers, unless the user turned
 * that question off. Bind `pending`, `confirm` and `cancel` to a
 * StackActionConfirmModal, and call `request` where the action used to run.
 * Mount the modal with `v-if="pending"`, so a closing one never shows
 * another action's text. App.vue hosts one per action.
 */
export function useStackActionConfirm(action: DestructiveStackAction, run: (project: string) => void) {
  const settingsStore = useSettingsStore();
  const pending = ref<PendingStackAction | null>(null);

  function request(project: string) {
    if (settingsStore.confirmStackActions[action]) pending.value = { action, project };
    else run(project);
  }

  function confirm(dontAskAgain: boolean) {
    const project = pending.value?.project;
    pending.value = null;
    if (project === undefined) return;
    if (dontAskAgain) settingsStore.setConfirmStackAction(action, false);
    run(project);
  }

  function cancel() {
    pending.value = null;
  }

  return { pending, request, confirm, cancel };
}
