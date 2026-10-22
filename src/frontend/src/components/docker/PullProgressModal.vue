<template>
  <BaseModal v-if="!inIframe" :is-open="isOpen" max-width="512px" @close="handleClose">
        <!-- Header -->
        <div class="flex items-center justify-between px-6 py-4 border-b border-border">
          <div class="min-w-0">
            <h2 class="text-base font-semibold text-text truncate">{{ modalTitle }}</h2>
            <p class="text-xs text-text-secondary font-mono truncate mt-0.5">{{ image }}</p>
          </div>
          <button
            v-if="isDone"
            @click="handleClose"
            class="p-1.5 border-none rounded cursor-pointer transition text-text-secondary hover:text-text shrink-0"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        <!-- Content -->
        <div class="flex-1 overflow-y-auto px-6 py-4 space-y-3">
          <!-- Status message -->
          <div class="flex items-center gap-2 text-sm">
            <svg v-if="!isDone" class="animate-spin h-4 w-4 text-primary shrink-0" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
              <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
              <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path>
            </svg>
            <svg v-else-if="isComplete" xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="text-success shrink-0">
              <polyline points="20 6 9 17 4 12" />
            </svg>
            <svg v-else xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="text-error shrink-0">
              <circle cx="12" cy="12" r="10" /><line x1="15" y1="9" x2="9" y2="15" /><line x1="9" y1="9" x2="15" y2="15" />
            </svg>
            <span class="text-text">{{ statusMessage }}</span>
          </div>

          <!-- Layer progress -->
          <div v-if="Object.keys(layers).length > 0" class="space-y-1.5">
            <div v-for="(layer, id) in layers" :key="id" class="flex items-center gap-2 text-xs">
              <span class="text-text-secondary font-mono w-16 shrink-0 truncate">{{ id }}</span>
              <div class="flex-1 h-1.5 stats-bar-track rounded-full overflow-hidden">
                <div
                  class="h-full rounded-full transition-all duration-300"
                  :class="layer.percent >= 100 ? 'bg-success' : 'bg-primary'"
                  :style="{ width: Math.min(layer.percent, 100) + '%' }"
                ></div>
              </div>
              <span class="text-text-secondary w-20 text-right shrink-0">{{ layer.status }}</span>
            </div>
          </div>

          <!-- Error message -->
          <div v-if="errorMessage" class="text-sm text-error bg-error/10 px-3 py-2 rounded">
            {{ errorMessage }}
          </div>

          <!-- Recreate progress -->
          <div v-if="recreateStatus" class="flex items-center gap-2 text-sm">
            <span class="text-text">{{ recreateMessage }}</span>
          </div>

          <p v-if="canOfferRecreate" class="text-xs text-text-secondary">
            The container still runs the old image. Recreate it to apply the update.
          </p>
        </div>

        <!-- Footer -->
        <div v-if="isDone" class="px-6 py-3 border-t border-border flex justify-end gap-2">
          <button @click="handleClose" class="nav-btn">Close</button>
          <button v-if="canOfferRecreate" @click="startRecreate" class="nav-btn active">Recreate</button>
        </div>
  </BaseModal>
</template>

<script setup lang="ts">
import { ref, computed, watch } from 'vue';
import { useBackend } from '@/backends';
import { useSettingsStore } from '@/stores/settings';
import { useParentModal } from '@/composables/useParentModal';
import BaseModal from '@/components/BaseModal.vue';

interface Props {
  isOpen: boolean;
  image: string;
  containerName: string;
  containerId?: string;
  force?: boolean;
  /** Apply an update pulled earlier: recreate the container, no pull. */
  recreateOnly?: boolean;
}

const props = defineProps<Props>();

const emit = defineEmits<{
  close: [];
  complete: [image: string];
}>();

interface LayerProgress {
  status: string;
  current: number;
  total: number;
  percent: number;
}

const settingsStore = useSettingsStore();
const postPullAction = computed(() => settingsStore.postPullAction);

const layers = ref<Record<string, LayerProgress>>({});
const statusMessage = ref('Preparing...');
const errorMessage = ref('');
const isComplete = ref(false);
const isDone = ref(false);
const recreateStatus = ref<'recreating' | 'recreated' | 'recreate_error' | null>(null);
const recreateMessage = ref('');
let abortController: AbortController | null = null;

const modalTitle = computed(() => {
  if (props.recreateOnly) return 'Apply Update';
  return props.force ? 'Force Update' : 'Pull Image Update';
});

/**
 * "Pull + offer recreate": once the pull is in, offer to recreate the
 * container so it runs the new image. A restart would keep the old one.
 * Not after a force update or an auto-recreate, which already recreated.
 */
const canOfferRecreate = computed(() =>
  isDone.value
  && isComplete.value
  && !props.force
  && !props.recreateOnly
  && !!props.containerId
  && postPullAction.value === 'pull_and_offer_restart'
  && recreateStatus.value === null,
);

const parentModal = useParentModal({
  onAction({ actionId }) {
    if (actionId === 'close' || actionId === 'cancel') {
      if (isDone.value) emit('close');
    } else if (actionId === 'recreate') {
      if (canOfferRecreate.value) startRecreate();
    }
  },
});

const { inIframe } = parentModal;

function openParent() {
  parentModal.open({
    kind: 'pull-progress',
    title: `${props.recreateOnly || props.force ? modalTitle.value : 'Pull Image'} — ${props.image}`,
    size: 'md',
    dismissable: false,
    fields: [
      { type: 'status', id: 'status', message: statusMessage.value, spinner: true },
      { type: 'progress-list', id: 'layers', items: [] },
    ],
    actions: [
      { id: 'close', label: 'Close', variant: 'default', hidden: true },
    ],
  });
}

function patchStatus() {
  if (!inIframe) return;
  parentModal.update({
    fields: [
      {
        id: 'status',
        message: statusMessage.value,
        spinner: !isDone.value,
        variant: !isDone.value ? 'info' : (isComplete.value ? 'success' : 'error'),
      },
    ],
  });
}

function patchLayer(layerId: string) {
  if (!inIframe) return;
  const layer = layers.value[layerId];
  if (!layer) return;
  parentModal.update({
    fields: [
      {
        id: 'layers',
        items: [
          {
            id: layerId,
            label: layerId,
            percent: layer.percent,
            status: layer.status,
            state: layer.percent >= 100 ? 'done' : 'running',
          },
        ],
      },
    ],
  });
}

function showCloseButton() {
  if (!inIframe) return;
  const actions: { id: string; label: string; variant: 'default' | 'primary' }[] = [
    { id: 'close', label: 'Close', variant: 'default' },
  ];
  if (canOfferRecreate.value) actions.push({ id: 'recreate', label: 'Recreate', variant: 'primary' });
  parentModal.update({ dismissable: true, actions });
}

function hideActions() {
  if (!inIframe) return;
  parentModal.update({
    dismissable: false,
    actions: [{ id: 'close', label: 'Close', variant: 'default', hidden: true }],
  });
}

function handleClose() {
  if (!isDone.value) return;
  emit('close');
}

function reset() {
  layers.value = {};
  statusMessage.value = 'Preparing...';
  errorMessage.value = '';
  isComplete.value = false;
  isDone.value = false;
  recreateStatus.value = null;
  recreateMessage.value = '';
}

async function startPull() {
  reset();
  if (props.recreateOnly) statusMessage.value = `Recreating ${props.containerName}...`;
  if (inIframe) openParent();
  if (props.recreateOnly && props.containerId) {
    await runStream({ containerIds: [props.containerId], recreateOnly: true });
    return;
  }
  await runStream(props.force && props.containerId ? { containerIds: [props.containerId], recreate: true } : {});
}

/**
 * Recreate the container on the image just pulled, with no second pull: the
 * image is on disk, and pulling again could bring in a build newer than the
 * one the user just saw.
 */
async function startRecreate() {
  if (!props.containerId) return;
  isDone.value = false;
  isComplete.value = false;
  statusMessage.value = `Recreating ${props.containerName}...`;
  hideActions();
  patchStatus();
  await runStream({ containerIds: [props.containerId], recreateOnly: true });
}

async function runStream(opts: { containerIds?: string[]; recreate?: boolean; recreateOnly?: boolean }) {
  const controller = new AbortController();
  abortController = controller;

  try {
    await useBackend().streams.pull(props.image, opts, handleSSEEvent, controller.signal);
  } catch (e: any) {
    if (e.name !== 'AbortError') {
      errorMessage.value = e.message || 'Pull failed';
      statusMessage.value = 'Error';
    }
  }

  // Closed while running: the modal is gone, so leave its state alone.
  if (abortController !== controller) return;
  isDone.value = true;
  patchStatus();
  showCloseButton();
}

function handleSSEEvent(event: string, data: any) {
  switch (event) {
    case 'status':
      statusMessage.value = data.message || 'Pulling...';
      patchStatus();
      break;
    case 'progress':
      if (data.id) {
        const existing = layers.value[data.id] || { status: '', current: 0, total: 0, percent: 0 };
        const current = data.current ?? existing.current;
        const total = data.total ?? existing.total;
        const percent = total > 0 ? Math.round((current / total) * 100) : (data.status === 'Pull complete' || data.status === 'Already exists' ? 100 : existing.percent);
        layers.value[data.id] = { status: data.status || existing.status, current, total, percent };
        layers.value = { ...layers.value };
        patchLayer(data.id);
      }
      break;
    case 'complete':
      // A recreate that failed is the outcome to show, not the pull under it.
      if (recreateStatus.value === 'recreate_error') {
        statusMessage.value = recreateMessage.value;
      } else {
        statusMessage.value = recreateStatus.value === 'recreated'
          ? recreateMessage.value
          : data.message || 'Pull complete';
        isComplete.value = true;
      }
      patchStatus();
      emit('complete', props.image);
      break;
    case 'recreating':
      recreateStatus.value = 'recreating';
      recreateMessage.value = data.message || `Recreating ${data.container}...`;
      statusMessage.value = recreateMessage.value;
      patchStatus();
      break;
    case 'recreated':
      recreateStatus.value = 'recreated';
      recreateMessage.value = data.message || `${data.container} updated`;
      statusMessage.value = recreateMessage.value;
      patchStatus();
      break;
    case 'recreate_error':
      recreateStatus.value = 'recreate_error';
      recreateMessage.value = data.message || `Failed to recreate ${data.container}`;
      statusMessage.value = recreateMessage.value;
      patchStatus();
      break;
    case 'error':
      errorMessage.value = data.message || 'Pull failed';
      statusMessage.value = 'Error';
      patchStatus();
      break;
    case 'done':
      isDone.value = true;
      patchStatus();
      showCloseButton();
      break;
  }
}

watch(() => props.isOpen, (open) => {
  if (open) {
    startPull();
  } else {
    if (abortController) {
      abortController.abort();
      abortController = null;
    }
    isDone.value = false;
    if (inIframe) parentModal.close();
  }
});
</script>
