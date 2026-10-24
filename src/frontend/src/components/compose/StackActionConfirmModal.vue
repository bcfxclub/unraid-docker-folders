<template>
  <ConfirmModal
    is-open
    :title="copy.title"
    :message="copy.message"
    :confirm-label="copy.title"
    variant="danger"
    checkbox-label="Don't ask again (turn it back on in Settings > Docker Folders)"
    @confirm="emit('confirm', $event)"
    @cancel="emit('cancel')"
  />
</template>

<script setup lang="ts">
import { computed } from 'vue';
import ConfirmModal from '@/components/ConfirmModal.vue';
import type { PendingStackAction } from '@/composables/useStackActionConfirm';

// Mounted only while an action is pending (see useStackActionConfirm).
const props = defineProps<{
  pending: PendingStackAction;
}>();

const emit = defineEmits<{
  confirm: [dontAskAgain: boolean];
  cancel: [];
}>();

// Both actions delete containers, so both say what survives and what is lost.
const copy = computed(() => {
  const { project, action } = props.pending;
  if (action === 'recompose') {
    return {
      title: 'Recompose',
      message: `Pull the latest images for "${project}" and rebuild every container in it? Each container is deleted and created again from the compose file, even if nothing changed. Volumes and the compose file are kept. Anything a container wrote outside a volume is lost.`,
    };
  }
  return {
    title: 'Stack Down',
    message: `Run docker compose down for "${project}"? Its containers and networks are deleted. Volumes and the compose file are kept, and Stack Up creates new containers. Anything a container wrote outside a volume is lost.`,
  };
});
</script>
