<template>
  <BaseModal v-if="!inIframe" :is-open="isOpen" max-width="400px" @close="$emit('cancel')">
    <div class="flex items-center gap-3 p-4 sm:p-6 pb-2">
      <div
        v-if="variant === 'danger'"
        class="flex items-center justify-center w-10 h-10 rounded-full bg-error/15 shrink-0"
      >
        <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="text-error">
          <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
          <line x1="12" y1="9" x2="12" y2="13" />
          <line x1="12" y1="17" x2="12.01" y2="17" />
        </svg>
      </div>
      <div
        v-else
        class="flex items-center justify-center w-10 h-10 rounded-full bg-primary/15 shrink-0"
      >
        <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="text-primary">
          <circle cx="12" cy="12" r="10" />
          <line x1="12" y1="8" x2="12" y2="12" />
          <line x1="12" y1="16" x2="12.01" y2="16" />
        </svg>
      </div>
      <div>
        <h3 class="text-base font-semibold text-text">{{ title }}</h3>
        <p class="text-sm text-text-secondary mt-1">{{ message }}</p>
        <label v-if="checkboxLabel" class="flex items-center gap-2 mt-3 text-sm text-text-secondary cursor-pointer">
          <input v-model="checked" type="checkbox" class="cursor-pointer" />
          {{ checkboxLabel }}
        </label>
      </div>
    </div>
    <div class="flex justify-end gap-2 p-4 sm:p-6 pt-4">
      <button ref="cancelBtn" type="button" @click="$emit('cancel')" class="nav-btn">取消</button>
      <button ref="confirmBtn" type="button" @click="$emit('confirm', checked)" class="nav-btn" :class="variant === 'danger' ? 'warning' : 'active'">{{ confirmLabel }}</button>
    </div>
  </BaseModal>
</template>

<script setup lang="ts">
import { watch, ref, nextTick } from 'vue';
import BaseModal from '@/components/BaseModal.vue';
import { useParentModal } from '@/composables/useParentModal';

interface Props {
  isOpen: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  variant?: 'danger' | 'default';
  /**
   * One optional checkbox under the message, such as "Don't ask again". Its
   * state comes back as the confirm event's argument. There is no slot for
   * other content: inside Unraid the dialog is drawn in the parent page,
   * which only sees these props.
   */
  checkboxLabel?: string;
}

const props = withDefaults(defineProps<Props>(), {
  confirmLabel: 'Confirm',
  variant: 'default',
});

const emit = defineEmits<{
  confirm: [checked: boolean];
  cancel: [];
}>();

const confirmBtn = ref<HTMLButtonElement | null>(null);
const checked = ref(false);

/** The parent-page field id for the checkbox. */
const CHECKBOX_FIELD = 'checkbox';

const parentModal = useParentModal({
  onAction({ actionId, values }) {
    if (actionId !== 'confirm') {
      emit('cancel');
      return;
    }
    emit('confirm', values[CHECKBOX_FIELD] === true);
  },
});

const { inIframe } = parentModal;

function openParent() {
  parentModal.open({
    kind: 'confirm',
    title: props.title,
    size: 'sm',
    fields: [
      { type: 'text', text: props.message },
      ...(props.checkboxLabel
        ? [{ type: 'checkbox' as const, id: CHECKBOX_FIELD, label: props.checkboxLabel, checked: false }]
        : []),
    ],
    actions: [
      { id: 'cancel', label: '取消', variant: 'default' },
      { id: 'confirm', label: props.confirmLabel, variant: props.variant === 'danger' ? 'danger' : 'primary' },
    ],
  });
}

watch(() => props.isOpen, (open) => {
  if (open) checked.value = false;
  if (inIframe) {
    if (open) openParent();
    else parentModal.close();
  } else if (open) {
    nextTick(() => confirmBtn.value?.focus());
  }
}, { immediate: true });
</script>
