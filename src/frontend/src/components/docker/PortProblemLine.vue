<template>
  <!-- What the backends' container watch found wrong with a running
       container's ports (containerPortProblem). State, not a tag, so it
       shows whatever the tag setting. -->
  <div v-if="problem" class="min-w-0 text-[11px] text-warning truncate" :title="`Running, but ${problem}`">
    Running, but {{ problem }}
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { Container } from '@/stores/docker';
import { containerPortProblem } from '@/utils/containerDisplay';

const props = defineProps<{ container: Container }>();

const problem = computed(() => containerPortProblem(props.container));
</script>
