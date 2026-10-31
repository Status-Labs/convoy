// Cost estimates from list prices and run time. They match compute billing
// for providers that bill by the second (DigitalOcean since 2026) but leave
// out usage charges such as extra bandwidth and snapshots.

import type { Vm } from "./types";

// DigitalOcean's minimum charge per droplet.
const MIN_BILLED_SECONDS = 60;

/** USD per hour this VM costs right now, or null if unknown. */
export function hourlyRate(vm: Vm): number | null {
  if (!vm.pricing) return null;
  return vm.status === "stopped" ? vm.pricing.stoppedHourly : vm.pricing.hourly;
}

/**
 * Estimated USD charged for this VM in the current calendar month (UTC), as
 * if it had been running since it was created or the month began.
 */
export function monthToDateCost(vm: Vm, now: Date = new Date()): number | null {
  if (!vm.pricing) return null;
  const monthStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
  const created = Date.parse(vm.createdAt);
  const start = Math.max(created, monthStart);
  let seconds = Math.max(0, (now.getTime() - start) / 1000);
  // The minimum applies once, to a VM created this month.
  if (created >= monthStart) seconds = Math.max(seconds, MIN_BILLED_SECONDS);
  const cost = (seconds / 3600) * vm.pricing.hourly;
  return vm.pricing.monthlyCap === null ? cost : Math.min(cost, vm.pricing.monthlyCap);
}

/** "$0.036" for rates, which are often under a cent per hour. */
export function formatRate(usdPerHour: number): string {
  return `$${usdPerHour < 1 ? usdPerHour.toFixed(3) : usdPerHour.toFixed(2)}`;
}

export function formatCost(usd: number): string {
  return usd > 0 && usd < 0.01 ? "<$0.01" : `$${usd.toFixed(2)}`;
}
