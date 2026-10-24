<template>
  <nav aria-label="Compose stacks" class="border border-border rounded bg-bg-card p-1">
    <div class="flex items-center justify-between px-2 pt-1.5 pb-1">
      <h2 class="text-[11px] font-bold uppercase text-text-secondary">Compose stacks</h2>
      <span class="text-[11px] text-text-secondary">{{ rows.length }}</span>
    </div>
    <p v-if="rows.length === 0" class="px-2 py-2 text-xs text-text-secondary">No compose stacks</p>
    <!-- The row is a div so the selected and hover tints apply: the button
         reset strips background and padding from a plain <button> (DESIGN.md
         §11), so the button carries no box of its own and its padding lives on
         the inner span. -->
    <div
      v-for="row in rows"
      :key="row.project"
      class="flex items-center gap-0.5 rounded transition-colors duration-150"
      :class="isSelected(row.project) ? 'bg-primary/15' : 'hover:bg-text/5'"
    >
      <button
        type="button"
        class="flex-1 min-w-0 text-left cursor-pointer text-text"
        :aria-pressed="isSelected(row.project)"
        :title="isSelected(row.project) ? 'Show all containers' : `Show only ${row.project}`"
        @click="toggle(row.project)"
      >
        <span class="flex items-center gap-2 py-1.5 pl-2 pr-1">
          <span
            class="shrink-0 inline-flex items-center justify-center min-w-6 h-5 px-1.5 rounded-full text-[11px] font-semibold"
            :class="row.running > 0 ? 'bg-primary text-primary-text' : 'bg-border text-text-secondary'"
            :title="`${row.running} running / ${row.total} total`"
          >{{ row.running }}/{{ row.total }}</span>
          <span class="flex flex-col min-w-0">
            <span class="text-sm font-semibold truncate">{{ row.project }}</span>
            <span
              class="text-[11px] truncate"
              :class="statuses.get(row.project)?.failed ? 'text-error' : 'text-text-secondary'"
              :title="statuses.get(row.project)?.text ?? row.location"
            >{{ statuses.get(row.project)?.text ?? row.location }}</span>
          </span>
        </span>
      </button>
      <KebabMenu
        :items="menuItems(row)"
        :button-title="`Actions for ${row.project}`"
        button-class="icon-btn text-text-secondary hover:text-text"
        no-wrap
        @select="(action) => handleSelect(row.project, action)"
      />
    </div>
    <ConfirmModal
      :is-open="!!downProject"
      title="Stack Down"
      :message="`Run docker compose down for &quot;${downProject}&quot;? Its containers and networks are removed. Volumes and the compose file are kept.`"
      confirm-label="Stack Down"
      variant="danger"
      @confirm="confirmDown"
      @cancel="downProject = null"
    />
  </nav>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { useComposeStore } from '@/stores/compose';
import { useDockerStore, type Container } from '@/stores/docker';
import { useFolderStore } from '@/stores/folders';
import KebabMenu from '@/components/KebabMenu.vue';
import type { KebabMenuItem } from '@/components/KebabMenu.vue';
import ConfirmModal from '@/components/ConfirmModal.vue';
import { byLabel } from '@/utils/menu';
import { STOPWATCH_ICON, TRASH_ICON } from '@/utils/menuIcons';
import { stackActionItems } from '@/utils/stackMenu';
import { naturalNameCompare } from '@/utils/sortMode';

interface StackRow {
  project: string;
  running: number;
  total: number;
  location: string;
}

const emit = defineEmits<{
  'edit-compose': [project: string];
  'compose-up': [project: string];
  'compose-recompose': [project: string];
  'compose-pull': [project: string];
  schedules: [targetType: string, targetId: string];
}>();

const composeStore = useComposeStore();
const dockerStore = useDockerStore();
const folderStore = useFolderStore();

/** How many folder names "In …" lists before it shortens to "+N more". */
const MAX_LISTED_FOLDERS = 2;

/**
 * Stop and down run here rather than in a progress modal, so the row's
 * folder line says what is happening ("Stopping…"), and its actions are
 * disabled until the call returns so a second click can't start an
 * overlapping one. A failure takes the line until the next action on that
 * stack.
 */
const statuses = ref(new Map<string, { text: string; failed: boolean }>());
const downProject = ref<string | null>(null);

function isSelected(project: string): boolean {
  return dockerStore.stackFilter === project;
}

function isBusy(project: string): boolean {
  const status = statuses.value.get(project);
  return !!status && !status.failed;
}

// Every known stack, plus any project seen only on container labels. Counts
// come from docker state, not `services_running`, which goes stale after an
// up or down (see useFolderRunningState).
const rows = computed<StackRow[]>(() => {
  const projects = new Set<string>(composeStore.stacks.map((s) => s.project_name));
  for (const project of dockerStore.containersByProject.keys()) projects.add(project);

  return [...projects].sort(naturalNameCompare).map((project) => {
    const members = dockerStore.containersInStack(project);
    return {
      project,
      running: members.filter((c) => c.state === 'running').length,
      total: members.length,
      location: locationText(members),
    };
  });
});

function locationText(members: Container[]): string {
  if (members.length === 0) return 'Not created';
  const names: string[] = [];
  for (const c of members) {
    const name = folderStore.folderByContainerName.get(c.name)?.name ?? 'Unfoldered';
    if (!names.includes(name)) names.push(name);
  }
  const listed = names.slice(0, MAX_LISTED_FOLDERS).join(', ');
  const rest = names.length - MAX_LISTED_FOLDERS;
  return rest > 0 ? `In ${listed} +${rest} more` : `In ${listed}`;
}

function toggle(project: string) {
  dockerStore.stackFilter = dockerStore.stackFilter === project ? null : project;
}

// The same stack actions as the folder kebab (stackActionItems), plus
// Schedules, which the folder header has as a button, and Stack Down.
function menuItems(row: StackRow): KebabMenuItem[] {
  const busy = isBusy(row.project);
  const disabled = composeStore.composeActionsDisabled || busy;
  const reason = (busy ? statuses.value.get(row.project)?.text : composeStore.composeDisabledReason) ?? undefined;
  const items = stackActionItems({
    running: row.running > 0,
    disabled,
    reason,
    pluginInstalled: composeStore.composePluginInstalled,
  });
  items.push({ label: 'Schedules', icon: STOPWATCH_ICON, action: 'schedules' });
  return [
    ...byLabel(items),
    { divider: true },
    { label: 'Stack Down', icon: TRASH_ICON, action: 'compose-down', show: row.total > 0, disabled, title: reason, class: 'hover:text-error' },
  ];
}

/** Run a stop or down, showing `label` on the row until it returns. */
async function runStackAction(
  project: string,
  label: string,
  action: (project: string) => Promise<{ success: boolean; error?: string }>,
) {
  if (isBusy(project)) return;
  statuses.value.set(project, { text: label, failed: false });
  let result: { success: boolean; error?: string } = { success: false };
  try {
    result = await action(project);
    await Promise.all([dockerStore.fetchContainers(), folderStore.fetchFolders()]);
  } finally {
    if (result.success) statuses.value.delete(project);
    else statuses.value.set(project, { text: result.error || 'Failed', failed: true });
  }
}

function confirmDown() {
  const project = downProject.value;
  downProject.value = null;
  if (project) runStackAction(project, 'Removing…', composeStore.stackDown);
}

function handleSelect(project: string, action: string) {
  // A new action clears an old failure, never a stop or down still running.
  if (!isBusy(project)) statuses.value.delete(project);
  if (action === 'compose-up') emit('compose-up', project);
  else if (action === 'compose-pull') emit('compose-pull', project);
  else if (action === 'compose-recompose') emit('compose-recompose', project);
  else if (action === 'compose-edit') emit('edit-compose', project);
  else if (action === 'schedules') emit('schedules', 'stack', project);
  else if (action === 'compose-stop') runStackAction(project, 'Stopping…', composeStore.stackStop);
  else if (action === 'compose-down') downProject.value = project;
}
</script>
