import type { Event } from "@/db/schema";
import type { CountAndPct, PersonCount, QualityStats } from "@/engine";
import { formatEventDate } from "@/lib/time";
import { compareNames } from "@/lib/names";
import type { ExportView } from "./common";

/**
 * `Matching_Quality_Report_<year>.txt`, sections A to G in the wording of
 * the output spec (2026_OUTPUT_GENERATION_PROMPT_TEMPLATE.txt section 3).
 * Every number comes from the run's stored `QualityStats`; the thresholds in
 * the labels (top 10, cutoff 27, 9 per supplier) come from the stats too.
 */

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

function pct(value: number): string {
  return `${value.toFixed(1)}%`;
}

function countPct(value: CountAndPct): string {
  return `${plural(value.count, "appointment", "appointments")} (${pct(value.pct)})`;
}

function distributionLines(stats: QualityStats, slotCount: number): string[] {
  const top = Math.max(slotCount, 6);
  const lines: string[] = [];
  for (let c = top; c >= 6; c--) {
    lines.push(`  * ${plural(c, "appointment", "appointments")}: ${plural(stats.buyerDistribution[c] ?? 0, "buyer", "buyers")}`);
  }
  const low = Object.entries(stats.buyerDistribution)
    .filter(([count]) => Number(count) <= 5)
    .reduce((sum, [, buyers]) => sum + buyers, 0);
  lines.push(`  * 5 or fewer: ${plural(low, "buyer", "buyers")}`);
  return lines;
}

function personLines(entries: PersonCount[], names: Map<string, string>): string[] {
  if (entries.length === 0) return ["  * None"];
  return entries
    .map((e) => ({ name: names.get(e.id) ?? e.id, count: e.count }))
    .sort((a, b) => a.count - b.count || compareNames(a.name, b.name))
    .map((e) => `  * ${e.name}: ${plural(e.count, "appointment", "appointments")}`);
}

/** One sentence on why lower-quality matches occur, built from the numbers. */
export function lowerQualityReason(stats: QualityStats): string {
  const { neitherTopN: neither, blankRankings: blank, thresholds: t } = stats;
  if (neither.count + blank.count === 0) {
    return `Every appointment has at least one side in the other's top ${t.mutualTopN}, so filling quotas never had to go further down the lists.`;
  }
  const parts = [
    `The ${plural(neither.count, "appointment", "appointments")} with neither side in the top ${t.mutualTopN}`,
    `and the ${plural(blank.count, "appointment", "appointments")} with a blank ranking`,
    `come from filling every supplier to exactly ${t.supplierTarget} (${stats.suppliersAtTarget} of ${stats.totalSuppliers} reached it)`,
    `and keeping buyers between ${t.buyerMin} and ${t.buyerMax} (${stats.buyersInRange} of ${stats.totalBuyers} are),`,
    `which uses slots after both sides' higher choices are taken or already booked in the same slot`,
  ];
  const mixed = neither.mixed > 0 ? `; ${neither.mixed} of the ${neither.count} are mixed rankings where the two sides rated each other very differently` : "";
  return `${parts.join(" ")}${mixed}.`;
}

function recommendations(stats: QualityStats): string[] {
  const t = stats.thresholds;
  const lines: string[] = [];
  lines.push(
    `- ${pct(stats.mutualTopN.pct)} of appointments are mutual top-${t.mutualTopN} pairs; a further ${pct(stats.oneSideTopN.pct)} have one side's top-${t.mutualTopN} choice.`,
  );
  if (stats.buyersBelowMin.length > 0) {
    lines.push(
      `- ${plural(stats.buyersBelowMin.length, "buyer has", "buyers have")} fewer than ${t.buyerMin} appointments. Check their open slots against suppliers with open slots before locking.`,
    );
  }
  if (stats.buyersAboveMax.length > 0) {
    lines.push(`- ${plural(stats.buyersAboveMax.length, "buyer has", "buyers have")} more than ${t.buyerMax} appointments.`);
  }
  if (stats.suppliersOffTarget.length > 0) {
    lines.push(
      `- ${plural(stats.suppliersOffTarget.length, "supplier is", "suppliers are")} not at exactly ${t.supplierTarget} appointments.`,
    );
  }
  const { buyerBlank, supplierBlank } = stats.blankRankings;
  if (buyerBlank + supplierBlank > 0) {
    const side = buyerBlank >= supplierBlank ? "buyers who did not rank the supplier" : "suppliers who did not rank the buyer";
    lines.push(`- Most blank rankings are ${side}. Asking participants to rank more of the list would reduce them.`);
  }
  return lines;
}

export type ReportEvent = Pick<Event, "name" | "eventDate" | "timezone"> & { settings: { slotCount: number } };

export function qualityReportText(view: Pick<ExportView, "buyers">, stats: QualityStats, event: ReportEvent): string {
  const t = stats.thresholds;
  const n = t.mutualTopN;
  const names = new Map(view.buyers.map((b) => [b.id, b.name]));
  const title = "MATCHING QUALITY STATISTICS REPORT";

  const lines = [
    title,
    event.name,
    formatEventDate(event.eventDate, event.timezone),
    "=".repeat(title.length),
    "",
    "A. OVERALL STATISTICS",
    `- Total appointments: ${stats.totalAppointments}`,
    `- Total buyers: ${stats.totalBuyers}`,
    `- Total suppliers: ${stats.totalSuppliers}`,
    "- Buyer appointment distribution:",
    ...distributionLines(stats, event.settings.slotCount),
    `- Supplier success rate: ${pct(stats.supplierSuccessPct)} with exactly ${t.supplierTarget} appointments`,
    `- Buyers within ${t.buyerMin} to ${t.buyerMax} appointments: ${stats.buyersInRange} of ${stats.totalBuyers} (${pct(stats.buyersInRangePct)})`,
    `- Buyers below target (fewer than ${t.buyerMin}): ${stats.buyersBelowMin.length}`,
    ...personLines(stats.buyersBelowMin, names),
    `- Buyers above target (more than ${t.buyerMax}): ${stats.buyersAboveMax.length}`,
    ...personLines(stats.buyersAboveMax, names),
    "",
    `B. MUTUAL TOP-${n} MATCHES`,
    `- Count: ${countPct(stats.mutualTopN)}`,
    `- Description: Both parties ranked each other in their top ${n}`,
    "",
    `C. ONE-SIDE TOP-${n} MATCHES (but not mutual)`,
    `- Total: ${countPct(stats.oneSideTopN)}`,
    "- Breakdown:",
    `  * ${plural(stats.oneSideTopN.buyerOnly, "appointment", "appointments")}: Buyer ranked supplier in top-${n}, but supplier ranked buyer lower (rank >${n})`,
    `  * ${plural(stats.oneSideTopN.supplierOnly, "appointment", "appointments")}: Supplier ranked buyer in top-${n}, but buyer ranked supplier lower (rank >${n})`,
    "",
    `D. NEITHER SIDE TOP-${n}`,
    `- Total: ${countPct(stats.neitherTopN)} where both ranked each other but neither in top ${n}`,
    "- Detailed breakdown:",
    `  * Mutual ranks ${n + 1}-${2 * n}: ${plural(stats.neitherTopN.bothWithin2N, "appointment", "appointments")}`,
    `  * Mutual ranks ${2 * n + 1}-${t.hotelRankCutoff}: ${plural(stats.neitherTopN.bothWithinCutoff, "appointment", "appointments")}`,
    `  * Mutual ranks >${t.hotelRankCutoff}: ${plural(stats.neitherTopN.bothAboveCutoff, "appointment", "appointments")}`,
    `  * Mixed rankings (one side ${n + 1}-${t.hotelRankCutoff}, other higher/lower): ${plural(stats.neitherTopN.mixed, "appointment", "appointments")}`,
    "",
    "E. BLANK RANKINGS",
    `- Total: ${countPct(stats.blankRankings)}`,
    "- Where one or both parties didn't provide rankings",
    `  * Buyer did not rank the supplier: ${plural(stats.blankRankings.buyerBlank, "appointment", "appointments")}`,
    `  * Supplier did not rank the buyer: ${plural(stats.blankRankings.supplierBlank, "appointment", "appointments")}`,
    "",
    "F. QUALITY SUMMARY",
    `✅ High Quality (Mutual top-${n}): ${countPct(stats.mutualTopN)}`,
    `⚠️ Medium Quality (One side top-${n}): ${countPct(stats.oneSideTopN)}`,
    `⚠️ Lower Quality (Neither top-${n}): ${countPct(stats.neitherTopN)}`,
    `ℹ️ Blank rankings: ${countPct(stats.blankRankings)}`,
    "",
    "G. KEY INSIGHTS",
    `- ${pct(stats.atLeastOneSideTopN.pct)} of appointments (${stats.atLeastOneSideTopN.count} of ${stats.totalAppointments}) have at least one party in the other's top ${n}.`,
    `- ${lowerQualityReason(stats)}`,
    ...recommendations(stats),
    "",
  ];
  return lines.join("\n");
}
