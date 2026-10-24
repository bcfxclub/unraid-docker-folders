<template>
  <!-- Size and color sit on the wrapper: the Unraid reset sets a plain
       button's font-size to inherit, which beats a utility on the button. -->
  <div v-if="failure" class="min-w-0 text-[11px] text-error">
    <button
      type="button"
      class="block w-full min-w-0 text-left truncate cursor-pointer"
      :title="`${failure.error} (click to dismiss)`"
      @click.stop="dockerStore.dismissActionFailure(container.name)"
    >{{ failure.error }}</button>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useDockerStore, type Container } from '@/stores/docker';

// The last failed action on a container, in Docker's words
// (dockerStore.actionFailureFor). Clicking dismisses it.
const props = defineProps<{ container: Container }>();

const dockerStore = useDockerStore();
const failure = computed(() => dockerStore.actionFailureFor(props.container));
</script>
