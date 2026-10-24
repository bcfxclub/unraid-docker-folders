<template>
  <div class="mb-1">
    <FolderHeader :folder="folder" :collapsed="!isExpanded" :hide-stopped="hideStopped" :hidden-count="hiddenCount" @toggle-collapse="toggleCollapse" @toggle-hide-stopped="hideStopped = !hideStopped" @edit="$emit('edit', folder)" @delete="$emit('delete', folder.id)" @update-folder="$emit('update-folder', folder)" @edit-compose="(p) => emit('edit-compose', p)" @compose-up="(p) => emit('compose-up', p)" @compose-recompose="(p) => emit('compose-recompose', p)" @compose-down="(p) => emit('compose-down', p)" @compose-pull="(p) => emit('compose-pull', p)" @schedules="(type, id) => emit('schedules', type, id)" />

    <div class="expand-grid" :class="{ 'expand-expanded': isExpanded, 'expand-settled': expandSettled }">
      <div class="expand-inner px-2 sm:px-4">
        <div
          class="container-list"
          :class="[
            view === 'list' ? 'flex flex-col gap-1.5' : 'grid grid-cols-[repeat(auto-fill,minmax(min(280px,100%),1fr))] gap-3',
            folderContainers.length > 0 ? 'mb-2 min-h-[60px]' : '',
          ]"
          :data-folder-id="folder.id"
        >
          <ContainerCard
            v-for="assoc in folderContainers"
            :key="assoc.container_name"
            :container="getContainer(assoc.container_name)!"
            :action-in-progress="actionsInProgress.get(getContainer(assoc.container_name)?.id ?? '') ?? null"
            :view="view"
            @start="handleStart"
            @resume="handleResume"
            @stop="handleStop"
            @restart="handleRestart"
            @remove="handleRemove"
            @pull="(data) => emit('pull', data)"
            @schedules="(type, id) => emit('schedules', type, id)"
            @security="(id) => emit('security', id)"
            @edit-compose="(p) => emit('edit-compose', p)"
          />
        </div>
        <!-- Compose folder: stack down — show faded service names as a preview -->
        <div
          v-if="folderContainers.length === 0 && folder.compose_project && previewAssociations.length > 0"
          class="mb-2 opacity-40 pointer-events-none select-none"
          :class="view === 'list' ? 'flex flex-col gap-1.5' : 'grid grid-cols-[repeat(auto-fill,minmax(min(280px,100%),1fr))] gap-3'"
        >
          <div
            v-for="name in previewAssociations"
            :key="name"
            class="flex items-center gap-2 px-3 py-2 bg-bg-card border border-border rounded"
          >
            <span class="w-2 h-2 rounded-full bg-text-secondary shrink-0"></span>
            <span class="text-sm text-text truncate">{{ name }}</span>
            <span class="ml-auto text-[10px] uppercase tracking-wide text-text-secondary">stopped</span>
          </div>
        </div>
        <div
          v-else-if="folderContainers.length === 0 && !folder.compose_project"
          class="text-center py-6 text-text-secondary border-2 border-dashed border-border rounded mb-2"
        >
          <p>No containers in this folder</p>
          <p class="text-sm italic">Drag containers here to organize them</p>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch, onMounted, onUnmounted, nextTick } from 'vue';
import { useDockerStore, type PullRequest } from '@/stores/docker';
import { useFolderStore } from '@/stores/folders';
import { useComposeStore } from '@/stores/compose';
import { useStatsStore } from '@/stores/stats';
import { useSettingsStore } from '@/stores/settings';
import type { Folder } from '@/types/folder';
import { effectiveSortMode, sortByMode } from '@/utils/sortMode';
import { safeLocalStorageGet, safeLocalStorageSet } from '@/utils/safeStorage';
import { isShownWhenHidingStopped } from '@/utils/containerDisplay';
import { containerMatchesSearch } from '@/utils/search';
import FolderHeader from './FolderHeader.vue';
import ContainerCard from '@/components/docker/ContainerCard.vue';

interface Props {
  folder: Folder;
  view?: 'grid' | 'list';
}

const props = withDefaults(defineProps<Props>(), {
  view: 'grid',
});

// Note: emit is used in template via $emit
const emit = defineEmits<{
  edit: [folder: Folder];
  delete: [id: number];
  pull: [data: PullRequest];
  'update-folder': [folder: Folder];
  'edit-compose': [project: string];
  'compose-up': [project: string];
  'compose-recompose': [project: string];
  'compose-down': [project: string];
  'compose-pull': [project: string];
  schedules: [targetType: string, targetId: string];
  security: [containerId: string];
}>();

const dockerStore = useDockerStore();
const folderStore = useFolderStore();
const composeStore = useComposeStore();
const statsStore = useStatsStore();
const settingsStore = useSettingsStore();
const actionsInProgress = ref<Map<string, string>>(new Map());

const storageKey = computed(() => `docker-folders-hide-stopped-${props.folder.id}`);
const hideStopped = ref(safeLocalStorageGet(`docker-folders-hide-stopped-${props.folder.id}`) === '1');
watch(hideStopped, (v) => safeLocalStorageSet(storageKey.value, v ? '1' : '0'));


// A search or a stack filter opens every folder it leaves on screen. While
// one is on, the header toggles this override instead of the saved state, so
// a folder can still be closed without changing how it is saved. Starting a
// filter, or picking another stack, opens them all again.
const filterCollapsed = ref(false);
watch(() => [dockerStore.isFiltering, dockerStore.stackFilter], () => {
  filterCollapsed.value = false;
});
const isExpanded = computed(() => (dockerStore.isFiltering ? !filterCollapsed.value : !props.folder.collapsed));

// Overflow on the expand container must stay hidden while the height
// transition runs (see .expand-settled in main.css), so mark the folder as
// settled shortly after the 200ms transition finishes. Collapse unsettles
// immediately so the closing transition can animate.
const expandSettled = ref(isExpanded.value);
let settleTimer: ReturnType<typeof setTimeout> | undefined;
watch(isExpanded, (expanded) => {
  clearTimeout(settleTimer);
  if (expanded) {
    settleTimer = setTimeout(() => {
      expandSettled.value = true;
    }, 220);
  } else {
    expandSettled.value = false;
  }
});
onUnmounted(() => clearTimeout(settleTimer));

// Associations whose container still exists in Docker. A removed container
// (e.g. after docker compose down) keeps its row, and must not be listed or counted.
const existingAssociations = computed(() =>
  (props.folder.containers || []).filter((assoc) => !!getContainer(assoc.container_name))
);

const folderContainers = computed(() => {
  let list = existingAssociations.value;
  if (dockerStore.isFiltering) {
    list = list.filter((assoc) => dockerStore.containerPassesFilters(getContainer(assoc.container_name), assoc.container_name));
  }
  if (hideStopped.value) {
    list = list.filter((assoc) => {
      const container = getContainer(assoc.container_name);
      return isShownWhenHidingStopped(container);
    });
  }
  return sortByMode(list, effectiveSortMode(props.folder.sort_mode, settingsStore.sortMode), (assoc) => {
    const container = getContainer(assoc.container_name);
    return {
      position: assoc.position,
      name: container?.name ?? assoc.container_name,
      state: container?.state,
      created: container?.created,
    };
  });
});

// Preview list for compose folders whose stack is down.
// Prefer the service names defined in the compose file (works even when
// the stack has been fully removed via `docker compose down`); fall back
// to stored container_folders rows if we have no stack metadata yet.
const previewAssociations = computed(() => {
  if (!props.folder.compose_project) return [];
  if (dockerStore.stackFilter !== null && !dockerStore.stackFilterKeepsDownStackFolder(props.folder.compose_project)) return [];
  const stack = composeStore.getStackByProject(props.folder.compose_project);
  let names: string[];
  if (stack?.service_names && stack.service_names.length > 0) {
    names = stack.service_names;
  } else {
    names = (props.folder.containers || []).map((a) => a.container_name);
  }
  names = names.filter((name) => containerMatchesSearch(dockerStore.searchQuery, name));
  return names;
});

const hiddenCount = computed(() => {
  if (!hideStopped.value) return 0;
  return existingAssociations.value.filter((assoc) => !isShownWhenHidingStopped(getContainer(assoc.container_name))).length;
});

function getContainer(name: string) {
  return dockerStore.containersByName.get(name);
}

function toggleCollapse() {
  const wasCollapsed = !isExpanded.value;
  if (dockerStore.isFiltering) filterCollapsed.value = !filterCollapsed.value;
  else folderStore.toggleFolderCollapse(props.folder.id);

  // Pre-fetch stats for running containers when expanding a folder
  // so data is ready by the time ContainerCard components mount
  if (wasCollapsed && settingsStore.showStats) {
    for (const assoc of folderContainers.value) {
      const container = getContainer(assoc.container_name);
      if (container?.state === 'running') {
        statsStore.registerVisible(container.id);
      }
    }
  }
}

// When collapsed, register running containers for stats polling so folder header can show totals.
// When expanded, ContainerCard handles its own registration, so we unregister ours.
const collapsedRegisteredIds = ref(new Set<string>());

function registerCollapsedStats() {
  unregisterCollapsedStats();
  if (isExpanded.value || !settingsStore.showStats) return;
  for (const assoc of folderContainers.value) {
    const container = getContainer(assoc.container_name);
    if (container?.state === 'running') {
      statsStore.registerVisible(container.id);
      collapsedRegisteredIds.value.add(container.id);
    }
  }
}

function unregisterCollapsedStats() {
  for (const id of collapsedRegisteredIds.value) {
    statsStore.unregisterVisible(id);
  }
  collapsedRegisteredIds.value.clear();
}

onMounted(() => registerCollapsedStats());
onUnmounted(() => unregisterCollapsedStats());

// Also when the listed containers change while collapsed: a filter can
// collapse a folder, and clearing or changing it changes who is listed.
watch([isExpanded, () => folderContainers.value.map((a) => a.container_name).join('\n')], ([expanded]) => {
  if (!expanded) {
    // Wait for ContainerCards to unmount first, then register
    nextTick(() => registerCollapsedStats());
  } else {
    unregisterCollapsedStats();
  }
});

watch(() => settingsStore.showStats, () => registerCollapsedStats());

async function handleStart(id: string) {
  actionsInProgress.value.set(id, 'start');
  try {
    await dockerStore.startContainer(id);
  } finally {
    actionsInProgress.value.delete(id);
  }
}

async function handleResume(id: string) {
  actionsInProgress.value.set(id, 'resume');
  try {
    await dockerStore.resumeContainer(id);
  } finally {
    actionsInProgress.value.delete(id);
  }
}

async function handleStop(id: string) {
  actionsInProgress.value.set(id, 'stop');
  try {
    await dockerStore.stopContainer(id);
  } finally {
    actionsInProgress.value.delete(id);
  }
}

async function handleRestart(id: string) {
  actionsInProgress.value.set(id, 'restart');
  try {
    await dockerStore.restartContainer(id);
  } finally {
    actionsInProgress.value.delete(id);
  }
}

async function handleRemove(id: string, removeImage = false) {
  actionsInProgress.value.set(id, 'remove');
  try {
    await dockerStore.removeContainer(id, removeImage);
  } finally {
    actionsInProgress.value.delete(id);
  }
}
</script>
