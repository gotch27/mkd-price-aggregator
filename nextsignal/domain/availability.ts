export const availabilityStates = [
  "available",
  "unavailable",
  "unknown",
  "not_listed",
] as const;
export type ProductAvailability = (typeof availabilityStates)[number];
export const availabilityFilters = [
  "available",
  "unavailable",
  "unknown",
  "all",
] as const;
