<template>
  <BaseModal v-if="!inIframe" :is-open="isOpen" max-width="512px" @close="handleClose">
        <!-- Header -->
        <div class="flex items-center justify-between px-6 py-4 border-b border-border">
          <div class="min-w-0">
            <h2 class="text-base font-semibold text-text truncate">
              {{ modalTitle() }}
            </h2>
          </div>
          <button
            v-if="allDone"
            @click="handleClose"
            class="p-1.5 border-none rounded cursor-pointer transition text-text-secondary hover:text-text shrink-0"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        <!-- Content -->
        <div class="flex-1 overflow-y-auto px-6 py-4 space-y-2">
          <div
            v-for="(unit, idx) in units"
            :key="unit.id"
            class="flex items-start gap-2 py-2"
            :class="idx < units.length - 1 ? 'border-b border-border/30' : ''"
          >
            <div class="flex-1 min-w-0">
              <p class="text-sm text-text font-mono truncate">{{ unitLabel(unit) }}</p>
              <p class="text-xs text-text-secondary truncate">{{ unitStatusText(unit.id) }}</p>
              <p v-if="unitErrors[unit.id]" class="text-xs text-error mt-1">{{ unitErrors[unit.id] }}</p>
            </div>
            <span class="shrink-0 text-xs font-medium" :class="statusLabelClass(unit.id)">
              {{ statusLabel(unit.id) }}
            </span>
          </div>
        </div>

        <p v-if="recreatableUnits.length > 0" class="px-6 pb-3 text-xs text-text-secondary">
          已更新的容器仍在运行旧镜像。请重建以应用更新。
        </p>

        <!-- Footer -->
        <div class="px-6 py-3 border-t border-border flex justify-end">
          <div class="flex gap-2">
            <button v-if="!allDone" @click="cancelBatch" class="nav-btn">取消</button>
            <button v-if="allDone" @click="handleClose" class="nav-btn">关闭</button>
            <button v-if="recreatableUnits.length > 0" @click="startRecreate" class="nav-btn active">重建</button>
          </div>
        </div>
  </BaseModal>
</template>

<script setup lang="ts">
import { ref, computed, watch } from 'vue';
import { useBackend } from '@/backends';
import { SseHttpError, SseNoStreamError } from '@/backends/sse';
import { useParentModal } from '@/composables/useParentModal';
import { useSettingsStore } from '@/stores/settings';
import BaseModal from '@/components/BaseModal.vue';
import { unitLabel, type UpdateUnit } from '@/utils/updateUnits';

interface Props {
  isOpen: boolean;
  units: UpdateUnit[];
}

const props = defineProps<Props>();

const emit = defineEmits<{
  close: [];
  complete: [];
}>();

interface LayerProgress {
  status: string;
  current: number;
  total: number;
  percent: number;
}

type UnitResult = 'success' | 'error' | 'cancelled';

const settingsStore = useSettingsStore();

// All per-unit state is keyed by unit id — several units run at once, so
// nothing here can be a single in-flight value.
const unitRunning = ref<Record<string, boolean>>({});
const unitStatus = ref<Record<string, string>>({});
const unitLayers = ref<Record<string, Record<string, LayerProgress>>>({});
const unitResults = ref<Record<string, UnitResult>>({});
const unitErrors = ref<Record<string, string>>({});
const unitRecreate = ref<Record<string, string>>({});
const allDone = ref(false);
/** Set once the recreate pass has run, so it is offered only once. */
const recreateRan = ref(false);

let cancelled = false;
/** One controller per in-flight unit; cancelling aborts every one of them. */
let controllers = new Set<AbortController>();
/** Guards against a pool settling after the modal has already closed. */
let runToken = 0;

const completedCount = computed(() => Object.keys(unitResults.value).length);

/**
 * "拉取并提供重建": the units whose pull went through, which still run
 * their old images until they are recreated. A restart would keep those.
 */
const recreatableUnits = computed(() => {
  if (!allDone.value || recreateRan.value) return [];
  if (settingsStore.postPullAction !== 'pull_and_offer_restart') return [];
  return props.units.filter((unit) => unitResults.value[unit.id] === 'success');
});

function statusLabel(id: string): string {
  const result = unitResults.value[id];
  if (result === 'success') return 'Done';
  if (result === 'error') return '错误';
  if (result === 'cancelled') return '已跳过';
  if (unitRunning.value[id]) return 'Updating';
  return 'Pending';
}

function statusLabelClass(id: string): string {
  const result = unitResults.value[id];
  if (result === 'success') return 'text-success';
  if (result === 'error') return 'text-error';
  if (result === 'cancelled') return 'text-text-secondary';
  if (unitRunning.value[id]) return 'text-primary';
  return 'text-text-secondary';
}

function unitState(id: string): 'pending' | 'running' | 'done' | 'error' | 'cancelled' {
  const result = unitResults.value[id];
  if (result === 'success') return 'done';
  if (result === 'error') return 'error';
  if (result === 'cancelled') return 'cancelled';
  if (unitRunning.value[id]) return 'running';
  return 'pending';
}

function unitPercent(id: string): number {
  if (unitResults.value[id]) return 100;
  if (!unitRunning.value[id]) return 0;
  const layers = Object.values(unitLayers.value[id] || {});
  if (layers.length === 0) return 5;
  const avg = layers.reduce((acc, l) => acc + l.percent, 0) / layers.length;
  return Math.max(5, avg);
}

function unitStatusText(id: string): string {
  const result = unitResults.value[id];
  if (result === 'success') return 'Done';
  if (result === 'error') return unitErrors.value[id] || '错误';
  if (result === 'cancelled') return '已跳过';
  if (unitRunning.value[id]) return unitStatus.value[id] || 'Updating...';
  return 'Pending';
}

function buildProgressItems() {
  return props.units.map((unit) => ({
    id: unit.id,
    label: unitLabel(unit),
    percent: unitPercent(unit.id),
    status: unitStatusText(unit.id),
    state: unitState(unit.id),
    sublabel: unitRecreate.value[unit.id] || '',
  }));
}

const parentModal = useParentModal({
  onAction({ actionId }) {
    if (actionId === 'cancel') {
      cancelBatch();
    } else if (actionId === 'close') {
      if (allDone.value) emit('close');
    } else if (actionId === 'recreate') {
      startRecreate();
    }
  },
});

const { inIframe } = parentModal;

function openParent() {
  parentModal.open({
    kind: 'batch-pull-progress',
    title: `Updating Containers (0/${props.units.length})`,
    size: 'md',
    dismissable: false,
    fields: [
      { type: 'progress-list', id: 'units', items: buildProgressItems() },
    ],
    actions: [
      { id: 'cancel', label: '取消', variant: 'default' },
    ],
  });
}

function modalTitle(): string {
  return allDone.value
    ? '更新完成'
    : `Updating Containers (${completedCount.value}/${props.units.length})`;
}

function patchAll() {
  if (!inIframe) return;
  parentModal.update({
    title: modalTitle(),
    fields: [{ id: 'units', items: buildProgressItems() }],
  });
}

function patchUnit(unit: UpdateUnit) {
  if (!inIframe) return;
  parentModal.update({
    title: modalTitle(),
    fields: [
      {
        id: 'units',
        items: [
          {
            id: unit.id,
            label: unitLabel(unit),
            percent: unitPercent(unit.id),
            status: unitStatusText(unit.id),
            state: unitState(unit.id),
            sublabel: unitRecreate.value[unit.id] || '',
          },
        ],
      },
    ],
  });
}

function showCloseAction() {
  if (!inIframe) return;
  const actions: { id: string; label: string; variant: 'default' | 'primary' }[] = [
    { id: 'close', label: '关闭', variant: 'default' },
  ];
  if (recreatableUnits.value.length > 0) actions.push({ id: 'recreate', label: '重建', variant: 'primary' });
  parentModal.update({ dismissable: true, actions });
}

function handleClose() {
  if (!allDone.value) return;
  emit('close');
}

function cancelBatch() {
  cancelled = true;
  for (const controller of controllers) {
    controller.abort();
  }
  controllers = new Set();
}

function reset() {
  unitRunning.value = {};
  unitStatus.value = {};
  unitLayers.value = {};
  unitResults.value = {};
  unitErrors.value = {};
  unitRecreate.value = {};
  allDone.value = false;
  recreateRan.value = false;
  cancelled = false;
  controllers = new Set();
}

function setStatus(id: string, text: string) {
  unitStatus.value = { ...unitStatus.value, [id]: text };
}

/**
 * Apply one SSE event to a unit's state. Returns 'success'/'error' on a
 * terminal event, otherwise null. `pull.php` and `compose-stream.php` share
 * the terminal vocabulary (complete/error/done) and differ only in how they
 * report progress, so one handler covers both.
 */
function applyEvent(
  unit: UpdateUnit,
  event: string,
  data: Record<string, any>,
): UnitResult | null {
  const id = unit.id;

  switch (event) {
    case 'status':
      setStatus(id, data.message || 'Updating...');
      break;

    // pull.php: per-layer download progress.
    case 'progress': {
      if (!data.id) break;
      const layers = { ...unitLayers.value[id] };
      const existing = layers[data.id] || { status: '', current: 0, total: 0, percent: 0 };
      const current = data.current ?? existing.current;
      const total = data.total ?? existing.total;
      const percent = total > 0
        ? Math.round((current / total) * 100)
        : (data.status === '拉取完成' || data.status === '已存在' ? 100 : existing.percent);
      layers[data.id] = { status: data.status || existing.status, current, total, percent };
      unitLayers.value = { ...unitLayers.value, [id]: layers };
      break;
    }

    // compose-stream.php: coarse phase markers, no layer data.
    case 'phase': {
      const percent = data.phase === 'starting' ? 80 : 40;
      unitLayers.value = { ...unitLayers.value, [id]: { phase: { status: data.phase || '', current: 0, total: 0, percent } } };
      setStatus(id, data.message || data.phase || 'Updating...');
      break;
    }

    // compose-stream.php: raw CLI output; show the newest non-empty line.
    case 'log': {
      const line = typeof data.line === 'string' ? data.line.trim() : '';
      if (line) setStatus(id, line);
      break;
    }

    case 'recreating':
    case 'recreated':
      setStatus(id, data.message || '');
      unitRecreate.value = { ...unitRecreate.value, [id]: data.message || '' };
      break;

    case 'recreate_error':
      unitRecreate.value = { ...unitRecreate.value, [id]: data.message || '' };
      unitErrors.value = { ...unitErrors.value, [id]: data.message || '重建失败' };
      break;

    // The pull went through, but a container that failed to recreate still
    // runs the old image, so the unit did not update.
    case 'complete':
      return unitErrors.value[id] ? 'error' : 'success';

    case 'error':
      unitErrors.value = { ...unitErrors.value, [id]: data.message || '更新失败' };
      return 'error';
  }

  return null;
}

async function runUnit(unit: UpdateUnit, recreate = false): Promise<UnitResult> {
  unitRunning.value = { ...unitRunning.value, [unit.id]: true };
  setStatus(unit.id, 'Preparing...');
  patchUnit(unit);

  const controller = new AbortController();
  controllers.add(controller);

  let result: UnitResult = 'error';

  const onEvent = (event: string, data: unknown) => {
    const terminal = applyEvent(unit, event, (data ?? {}) as Record<string, any>);
    if (terminal) result = terminal;
    patchUnit(unit);
  };

  try {
    if (unit.kind === 'compose') {
      // `up` pulls and then recreates changed services; `pull` downloads only.
      // Honour the same post-pull setting standalone containers use.
      // The recreate pass always runs `up`, which recreates what changed.
      const action = recreate || settingsStore.postPullAction === 'pull_and_auto_recreate' ? 'up' : 'pull';
      await useBackend().streams.compose(unit.project, action, {}, onEvent, controller.signal);
    } else {
      // Send the exact container set the confirm dialog listed, so the
      // backend recreates those and nothing else.
      const containerIds = unit.containers.map((c) => c.id);
      await useBackend().streams.pull(
        unit.image,
        // The recreate pass applies the image just pulled, so no second pull.
        recreate ? { containerIds, recreateOnly: true } : { containerIds },
        onEvent,
        controller.signal,
      );
    }

    return result;
  } catch (e: any) {
    if (e.name === 'AbortError') return 'error';
    // A response-level failure (non-2xx, or no readable stream) is treated
    // as a silent 'error' here — matches the original inline fetch, which
    // never set unitErrors for these two cases, unlike the single-unit
    // PullProgressModal/ComposeProgressModal, which do show them.
    if (e instanceof SseHttpError || e instanceof SseNoStreamError) return 'error';
    unitErrors.value = { ...unitErrors.value, [unit.id]: e.message || '更新失败' };
    return 'error';
  } finally {
    controllers.delete(controller);
    unitRunning.value = { ...unitRunning.value, [unit.id]: false };
  }
}

function finishUnit(unit: UpdateUnit, result: UnitResult) {
  unitResults.value = { ...unitResults.value, [unit.id]: result };
  patchUnit(unit);
}

/**
 * Run units through a pool of `updateConcurrency` workers that share one
 * cursor, so a fast unit immediately picks up the next instead of waiting on
 * a slow sibling.
 */
async function runPool(units: UpdateUnit[], recreate: boolean) {
  const limit = Math.max(1, Math.min(settingsStore.updateConcurrency, units.length));
  let cursor = 0;
  const worker = async () => {
    while (cursor < units.length) {
      const unit = units[cursor++];
      if (cancelled) {
        finishUnit(unit, 'cancelled');
        continue;
      }
      const result = await runUnit(unit, recreate);
      finishUnit(unit, cancelled && result === 'error' ? 'cancelled' : result);
    }
  };

  await Promise.all(Array.from({ length: limit }, worker));
}

function finishRun(token: number) {
  // The modal may have been closed (and a new batch started) while the pool
  // drained — don't resurrect a dead run.
  if (token !== runToken || !props.isOpen) return;

  allDone.value = true;
  patchAll();
  showCloseAction();
  emit('complete');
}

async function startBatch() {
  reset();
  const token = ++runToken;
  if (inIframe) openParent();

  await runPool([...props.units], false);
  finishRun(token);
}

/** The second pass "拉取并提供重建" offers once the pulls are in. */
async function startRecreate() {
  const units = recreatableUnits.value;
  if (units.length === 0) return;

  recreateRan.value = true;
  allDone.value = false;
  cancelled = false;
  const token = ++runToken;

  const without = <T,>(record: Record<string, T>) =>
    Object.fromEntries(Object.entries(record).filter(([id]) => !units.some((unit) => unit.id === id)));
  unitResults.value = without(unitResults.value);
  unitErrors.value = without(unitErrors.value);
  unitRecreate.value = without(unitRecreate.value);
  unitLayers.value = without(unitLayers.value);
  unitStatus.value = without(unitStatus.value);

  if (inIframe) {
    parentModal.update({
      dismissable: false,
      actions: [{ id: 'cancel', label: '取消', variant: 'default' }],
    });
  }
  patchAll();

  await runPool(units, true);
  finishRun(token);
}

watch(() => props.isOpen, (open) => {
  if (open && props.units.length > 0) {
    startBatch();
  } else if (!open) {
    runToken++;
    cancelBatch();
    if (inIframe) parentModal.close();
  }
});
</script>
