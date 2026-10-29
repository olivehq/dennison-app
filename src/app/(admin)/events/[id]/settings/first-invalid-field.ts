type Problem = { message?: string } | undefined;

/** The part of react-hook-form's errors this page reads. */
export type SettingsFormErrors = {
  name?: Problem;
  eventDate?: Problem;
  timezone?: Problem;
  settings?: {
    slotCount?: Problem;
    // Row errors by index, plus the message for the list as a whole.
    slots?: {
      message?: string;
      root?: Problem;
      length?: number;
      [index: number]: { startMinutes?: Problem; endMinutes?: Problem } | undefined;
    };
    supplierTarget?: Problem;
    buyerMin?: Problem;
    buyerIdeal?: Problem;
    buyerMax?: Problem;
    mutualTopN?: Problem;
    hotelRankCutoff?: Problem;
    biztechOptInRule?: Problem;
  };
};

type Candidate = { label: string; id: string; problem: Problem };

/**
 * The first field on the page that failed validation: the toast text that names it and the id of
 * the input to bring into view. Null when nothing has a message.
 */
export function firstInvalidField(errors: SettingsFormErrors): { message: string; id: string } | null {
  const s = errors.settings;
  const slots = s?.slots;
  const slotRows: Candidate[] = Array.from({ length: slots?.length ?? 0 }, (_, index) => [
    { label: `Slot ${index + 1} start`, id: `slot-${index}-start`, problem: slots?.[index]?.startMinutes },
    { label: `Slot ${index + 1} end`, id: `slot-${index}-end`, problem: slots?.[index]?.endMinutes },
  ]).flat();
  // In page order.
  const candidates: Candidate[] = [
    { label: "Name", id: "name", problem: errors.name },
    { label: "Show date", id: "eventDate", problem: errors.eventDate },
    { label: "Timezone", id: "timezone", problem: errors.timezone },
    { label: "Slots", id: "rebuild-count", problem: s?.slotCount },
    ...slotRows,
    { label: "Slots", id: "rebuild-count", problem: slots?.message ? { message: slots.message } : slots?.root },
    { label: "Meetings per supplier", id: "supplierTarget", problem: s?.supplierTarget },
    { label: "Buyer minimum", id: "buyerMin", problem: s?.buyerMin },
    { label: "Buyer ideal", id: "buyerIdeal", problem: s?.buyerIdeal },
    { label: "Buyer maximum", id: "buyerMax", problem: s?.buyerMax },
    { label: "Mutual top N", id: "mutualTopN", problem: s?.mutualTopN },
    { label: "Hotel rank cutoff", id: "hotelRankCutoff", problem: s?.hotelRankCutoff },
    { label: "Biztech opt-in", id: "biztechOptInRule", problem: s?.biztechOptInRule },
  ];
  const first = candidates.find((candidate) => candidate.problem?.message);
  return first ? { message: `${first.label}: ${first.problem?.message}`, id: first.id } : null;
}
