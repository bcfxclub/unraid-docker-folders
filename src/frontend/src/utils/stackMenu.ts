import type { KebabMenuItem } from '@/components/KebabMenu.vue';
import { DOWNLOAD_ICON, EDIT_ICON, PLAY_ICON, REFRESH_ICON, STOP_ICON } from '@/utils/menuIcons';

/**
 * The compose stack actions shared by the folder kebab and the stacks pane.
 *
 * Compose availability is an async check, so these are disabled rather than
 * hidden; hiding them made the menu reflow once the status landed. `show` is
 * still used for the entries that depend on container state (up vs stop),
 * which we already have.
 */
export function stackActionItems(opts: {
  /** Whether any of the stack's containers is running. */
  running: boolean;
  /** Set while the compose status check is pending or says compose is unusable. */
  disabled: boolean;
  /** Why the actions are disabled, as a tooltip. */
  reason?: string;
  /** The Compose Manager plugin owns the files, so the editor is read-only. */
  pluginInstalled: boolean;
}): KebabMenuItem[] {
  const { running, disabled, reason: title } = opts;
  return [
    { label: 'Stack Up', icon: PLAY_ICON, action: 'compose-up', show: !running, disabled, title },
    { label: 'Stop All', icon: STOP_ICON, action: 'compose-stop', show: running, disabled, title },
    { label: 'Pull Latest Images', icon: DOWNLOAD_ICON, action: 'compose-pull', disabled, title },
    { label: 'Recompose', icon: REFRESH_ICON, action: 'compose-recompose', show: running, disabled, title },
    { label: opts.pluginInstalled ? 'View Stack' : 'Edit Stack', icon: EDIT_ICON, action: 'compose-edit' },
  ];
}
