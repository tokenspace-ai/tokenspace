import { TokenspaceError } from "./error";
import { getApprovals, pushApproval, replaceApprovals } from "./runtime-context";

export type ApprovalRequirement = {
  action: string;
  data?: Record<string, any>;
  info?: Record<string, any>;
  description?: string;
};

/**
 * Error thrown when an action requires human approval.
 * The agent should catch this error and request approval from the user.
 */
export class ApprovalRequiredError extends TokenspaceError {
  public readonly requirements: ApprovalRequirement[];
  constructor(req: ApprovalRequirement | ApprovalRequirement[]) {
    super(`Approval required for ${Array.isArray(req) ? req[0]?.action : req.action}`, undefined, undefined, {
      errorType: "APPROVAL_REQUIRED",
      approval: req,
    });
    this.name = "ApprovalRequiredError";
    this.requirements = Array.isArray(req) ? req : [req];
  }
}

export const APPROVAL_WILDCARD = "*";

export type ApprovalData = Record<string, any | typeof APPROVAL_WILDCARD>;

export type Approval = {
  action: string | typeof APPROVAL_WILDCARD;
  data?: ApprovalData;
};

/**
 * Serializable approval format for passing between runtime and backend.
 * Wildcards are represented as "*" strings.
 */
export type SerializableApproval = {
  action: string;
  data?: Record<string, any>;
};

/**
 * Initialize approvals for the current execution context.
 * Called by the runtime before executing user code.
 */
export function initializeApprovals(newApprovals: SerializableApproval[]): void {
  replaceApprovals(newApprovals);
}

/**
 * Clear all approvals. Used for testing and between executions.
 */
export function clearApprovals(): void {
  replaceApprovals([]);
}

function matchesActionPattern(pattern: string, action: string): boolean {
  if (pattern === APPROVAL_WILDCARD) return true;
  if (!pattern.includes("*")) return pattern === action;

  // Handle patterns like "domain:*" matching "domain:actionName"
  const regexPattern = pattern.replace(/\*/g, ".*");
  return new RegExp(`^${regexPattern}$`).test(action);
}

function matchesDataValue(approvalValue: any, requirementValue: any): boolean {
  if (approvalValue === APPROVAL_WILDCARD) return true;
  if (approvalValue === undefined) return true;
  if (typeof approvalValue !== typeof requirementValue) return false;

  if (typeof approvalValue === "object" && approvalValue !== null) {
    if (Array.isArray(approvalValue)) {
      return (
        Array.isArray(requirementValue) &&
        approvalValue.length === requirementValue.length &&
        approvalValue.every((v, i) => matchesDataValue(v, requirementValue[i]))
      );
    }
    // For objects, recursively check all keys in the approval
    for (const key of Object.keys(approvalValue)) {
      if (!matchesDataValue(approvalValue[key], requirementValue?.[key])) {
        return false;
      }
    }
    return true;
  }

  return approvalValue === requirementValue;
}

function matchesApproval(approval: Approval, approvalRequirement: ApprovalRequirement): boolean {
  // Check action match (with wildcard support)
  if (!matchesActionPattern(approval.action, approvalRequirement.action)) {
    return false;
  }

  // If approval has no data constraints, it matches any data
  if (!approval.data) return true;

  // Check each data field in the approval against the requirement
  const requirementData = approvalRequirement.data || {};
  for (const key of Object.keys(approval.data)) {
    if (!matchesDataValue(approval.data[key], requirementData[key])) {
      return false;
    }
  }

  return true;
}

export function requireApproval(approvalRequirement: ApprovalRequirement): void {
  const approvals = getApprovals();
  if (!approvals.some((approval) => matchesApproval(approval, approvalRequirement))) {
    throw new ApprovalRequiredError(approvalRequirement);
  }
}

export function addApproval(approval: Approval): void {
  pushApproval(approval);
}

/**
 * Check if an approval exists without throwing.
 * Useful for conditional logic based on approval status.
 */
export function hasApproval(approvalRequirement: ApprovalRequirement): boolean {
  const approvals = getApprovals();
  return approvals.some((approval) => matchesApproval(approval, approvalRequirement));
}
