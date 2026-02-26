// sop/types.ts — SOP Engine core type definitions

// ── Trigger ─────────────────────────────────────────────────

export type SopTriggerType = 'cron' | 'webhook' | 'event' | 'manual'

export interface SopTrigger {
  type: SopTriggerType
  /** For type: 'cron' — cron expression e.g. "0 8 * * 1-5" */
  expr?: string
  /** For type: 'event' — event name e.g. "chat.complete" */
  event?: string
}

// ── Step ─────────────────────────────────────────────────────

export interface SopStep {
  /** 1-based step number (parsed from "## Step N: Title") */
  number: number
  /** Step title extracted from the heading */
  title: string
  /** Step body text (everything under the heading until the next heading) */
  body: string
  /** Optional list of tool names that this step is expected to use */
  suggestedTools?: string[]
  /** If true, executor waits for human confirmation before proceeding */
  requiresConfirmation?: boolean
}

// ── SOP Definition ───────────────────────────────────────────

export type SopExecutionMode = 'auto' | 'supervised' | 'step_by_step'

export interface Sop {
  /** Derived from the filename without extension, e.g. "morning-check" */
  slug: string
  /** Human-readable name from frontmatter */
  name: string
  /** List of triggers that can start this SOP */
  triggers: SopTrigger[]
  /** How the SOP should be executed */
  executionMode: SopExecutionMode
  /** Minimum seconds between executions (cooldown) */
  cooldownSecs: number
  /** Ordered list of steps */
  steps: SopStep[]
  /** Absolute path to the source Markdown file */
  filePath: string
  /** Whether this SOP is active; defaults to true */
  enabled: boolean
}

// ── Execution State Machine ──────────────────────────────────

export type SopExecutionStatus =
  | 'pending'
  | 'running'
  | 'awaiting_approval'
  | 'completed'
  | 'failed'
  | 'cancelled'

export type SopStepStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'skipped'

export interface SopStepResult {
  stepNumber: number
  status: SopStepStatus
  startedAt: string          // ISO 8601
  completedAt?: string       // ISO 8601, absent when still running
  output?: string            // Step output text
  error?: string             // Error message on failure
}

export interface SopExecution {
  id: string
  sopSlug: string
  status: SopExecutionStatus
  /** Index of the step currently executing or awaiting (1-based) */
  currentStep: number
  stepResults: SopStepResult[]
  startedAt: string          // ISO 8601
  completedAt?: string       // ISO 8601
  /** Human-readable reason for cancellation or failure */
  failureReason?: string
}
