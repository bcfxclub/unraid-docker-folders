/**
 * Totals for a group of containers: a folder, or every running container.
 *
 * Container stats use Docker's CPU scale, where 100% is one core, and each
 * container's memory percent is against its own limit. `cpuSum` adds the
 * members on that same scale, so a folder reads like its container rows: one
 * container at 100% makes the folder at least 100%. `cpuPercent` is the same
 * sum over the host core count, for a gauge where 100% is the whole server.
 * Memory is the summed usage over host memory.
 */

import type { ContainerStats } from '@/stores/stats';

export interface AggregateStats {
  /** Members' CPU added up on Docker's scale, where 100% is one core. */
  cpuSum: number;
  /** Share of all host cores, 0 to 100. */
  cpuPercent: number;
  /** Share of host memory, 0 to 100. */
  memPercent: number;
  memoryUsage: number;
  hostMemory: number;
  hostCpus: number;
  count: number;
}

export function aggregateStats(list: ContainerStats[]): AggregateStats | null {
  if (list.length === 0) return null;
  let cpu = 0;
  let memoryUsage = 0;
  let maxLimit = 0;
  let hostCpus = 0;
  let hostMemory = 0;
  for (const s of list) {
    cpu += s.cpuPercent;
    memoryUsage += s.memoryUsage;
    if (s.memoryLimit > maxLimit) maxLimit = s.memoryLimit;
    if (!hostCpus && s.hostCpus) hostCpus = s.hostCpus;
    if (!hostMemory && s.hostMemory) hostMemory = s.hostMemory;
  }
  // A backend older than the host fields: the plain Docker-scale sum, and the
  // largest limit, which is host memory for any container without a limit.
  if (!hostCpus) hostCpus = 1;
  if (!hostMemory) hostMemory = maxLimit;
  return {
    cpuSum: cpu,
    cpuPercent: cpu / hostCpus,
    memPercent: hostMemory > 0 ? (memoryUsage / hostMemory) * 100 : 0,
    memoryUsage,
    hostMemory,
    hostCpus,
    count: list.length,
  };
}
