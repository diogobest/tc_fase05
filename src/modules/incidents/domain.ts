import { AppError } from "../../shared/errors.ts";

export const statuses = ["open", "under_review", "in_progress", "resolved", "cancelled"] as const;
export const priorities = ["low", "medium", "high", "critical"] as const;
export type IncidentStatus = typeof statuses[number];

const transitions: Record<IncidentStatus, readonly IncidentStatus[]> = {
  open: ["under_review", "cancelled"],
  under_review: ["in_progress", "cancelled"],
  in_progress: ["resolved", "cancelled"],
  resolved: [], cancelled: [],
};

export function validateTransition(from: IncidentStatus, to: IncidentStatus, observation?: string, solution?: string) {
  if (!transitions[from].includes(to))
    throw new AppError(409, "INVALID_STATUS_TRANSITION", `Cannot transition from ${from} to ${to}`);
  if (to === "cancelled" && !observation?.trim())
    throw new AppError(422, "OBSERVATION_REQUIRED", "An observation is required to cancel an incident");
  if (to === "resolved" && !solution?.trim())
    throw new AppError(422, "SOLUTION_REQUIRED", "A solution is required to resolve an incident");
}
