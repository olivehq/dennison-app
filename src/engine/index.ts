export type {
  Appointment,
  AppointmentSource,
  BiztechOptInRule,
  Buyer,
  Conflict,
  CountAndPct,
  EventSettings,
  MatchInput,
  MatchResult,
  ParticipantType,
  PersonCount,
  QualityStats,
  Ranking,
  Supplier,
  SupplierType,
} from './types';
export { repairSchedule, runMatching, sortAppointments } from './match';
export { computeStats } from './stats';
export { findConflicts } from './validate';
export { buildRankingIndex, isTopN, pairKey, type RankingIndex } from './rankings';
export { isEligible, type EligibilityContext } from './eligibility';
