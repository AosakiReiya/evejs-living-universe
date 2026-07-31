"use strict";

const MODE = Object.freeze({
  WARMING: "warming",
  HEALTHY: "healthy",
  CONSTRAINED: "constrained",
  OVERLOADED: "overloaded",
  SHED: "shed",
  UNPLAYABLE: "unplayable",
  RECOVERING: "recovering",
});

const WORK_CLASS = Object.freeze({
  SETTLEMENT: "settlement",
  DEADLINE: "deadline",
  PLANNING: "planning",
  MAINTENANCE: "maintenance",
});

function toFiniteNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function percentile(values, fraction) {
  const sorted = (Array.isArray(values) ? values : [])
    .map((value) => Math.max(0, toFiniteNumber(value, 0)))
    .sort((left, right) => left - right);
  if (sorted.length === 0) return 0;
  const index = Math.max(0, Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1));
  return sorted[index];
}

function normalizeOptions(raw = {}) {
  const warningMs = Math.max(101, toFiniteNumber(raw.warningMs, 120));
  const overloadMs = Math.max(warningMs, toFiniteNumber(raw.overloadMs, 130));
  const emergencyShedMs = Math.max(overloadMs, toFiniteNumber(raw.emergencyShedMs, 500));
  const unplayableMs = Math.max(emergencyShedMs, toFiniteNumber(raw.unplayableMs, 600));
  return {
    baselineMs: Math.max(1, toFiniteNumber(raw.baselineMs, 100)),
    warningMs,
    overloadMs,
    emergencyShedMs,
    unplayableMs,
    minimumSamples: Math.max(2, Math.trunc(toFiniteNumber(raw.minimumSamples, 20))),
    sampleCount: Math.max(2, Math.trunc(toFiniteNumber(raw.sampleCount, 20))),
    recoveryMs: Math.max(0, toFiniteNumber(raw.recoveryMs, 5_000)),
    recoveryThresholdMs: Math.min(
      warningMs,
      Math.max(1, toFiniteNumber(raw.recoveryThresholdMs, 115)),
    ),
    healthyBudgetMs: Math.max(0.1, toFiniteNumber(raw.healthyBudgetMs, 2)),
    healthyMaxJobs: Math.max(1, Math.trunc(toFiniteNumber(raw.healthyMaxJobs, 32))),
  };
}

class XEveLoadGovernor {
  constructor(options = {}) {
    this.options = normalizeOptions(options);
    this.mode = MODE.WARMING;
    this.recoveryStartedAtMs = 0;
    this.lastPolicy = null;
    this.metrics = {
      evaluations: 0,
      constrainedEvaluations: 0,
      overloadedEvaluations: 0,
      shedEvaluations: 0,
      unplayableEvaluations: 0,
      recoveryTransitions: 0,
    };
  }

  evaluate(rawSummaries = [], nowMs = Date.now()) {
    const now = Math.max(0, Math.trunc(toFiniteNumber(nowMs, Date.now())));
    const summaries = (Array.isArray(rawSummaries) ? rawSummaries : [])
      .slice(-this.options.sampleCount);
    const intervals = summaries.map((summary) => (
      Math.max(0, toFiniteNumber(summary && summary.actualIntervalMs, 0))
    ));
    const latestMs = intervals.length > 0 ? intervals[intervals.length - 1] : 0;
    const p95Ms = percentile(intervals, 0.95);
    const maximumMs = intervals.length > 0 ? Math.max(...intervals) : 0;
    let candidateMode = MODE.HEALTHY;
    // The maximum remains useful telemetry, but an old one-off pause must not
    // poison every scheduling decision until it falls out of the sample window.
    // React immediately when the latest tick stalls; reserve p95 for sustained
    // pressure across the window.
    if (latestMs >= this.options.unplayableMs || p95Ms >= this.options.unplayableMs) {
      candidateMode = MODE.UNPLAYABLE;
    } else if (latestMs >= this.options.emergencyShedMs) {
      candidateMode = MODE.SHED;
    } else if (summaries.length < this.options.minimumSamples) {
      candidateMode = MODE.WARMING;
    } else if (p95Ms >= this.options.overloadMs) {
      candidateMode = MODE.OVERLOADED;
    } else if (p95Ms >= this.options.warningMs) {
      candidateMode = MODE.CONSTRAINED;
    }

    const wasPressured = [
      MODE.CONSTRAINED,
      MODE.OVERLOADED,
      MODE.SHED,
      MODE.UNPLAYABLE,
      MODE.RECOVERING,
    ].includes(this.mode);
    const priorEmergencyWasIsolated = [
      MODE.SHED,
      MODE.UNPLAYABLE,
    ].includes(this.mode) &&
      this.lastPolicy &&
      this.lastPolicy.p95Ms < this.options.warningMs;
    if (
      candidateMode === MODE.HEALTHY &&
      wasPressured &&
      p95Ms >= this.options.recoveryThresholdMs
    ) {
      candidateMode = MODE.CONSTRAINED;
    }
    if (
      candidateMode === MODE.HEALTHY &&
      wasPressured &&
      !priorEmergencyWasIsolated
    ) {
      if (this.recoveryStartedAtMs <= 0) {
        this.recoveryStartedAtMs = now;
        this.metrics.recoveryTransitions += 1;
      }
      if (now - this.recoveryStartedAtMs < this.options.recoveryMs) {
        candidateMode = MODE.RECOVERING;
      } else {
        this.recoveryStartedAtMs = 0;
      }
    } else if (candidateMode === MODE.HEALTHY && priorEmergencyWasIsolated) {
      // A one-tick persistence pause already shed the pass that observed it.
      // Keeping the recovery timer afterward would starve maintenance when
      // otherwise healthy durability pauses occur regularly.
      this.recoveryStartedAtMs = 0;
    } else if (candidateMode !== MODE.RECOVERING) {
      this.recoveryStartedAtMs = 0;
    }

    this.mode = candidateMode;
    this.metrics.evaluations += 1;
    if (candidateMode === MODE.CONSTRAINED || candidateMode === MODE.RECOVERING) {
      this.metrics.constrainedEvaluations += 1;
    } else if (candidateMode === MODE.OVERLOADED) {
      this.metrics.overloadedEvaluations += 1;
    } else if (candidateMode === MODE.SHED) {
      this.metrics.shedEvaluations += 1;
    } else if (candidateMode === MODE.UNPLAYABLE) {
      this.metrics.unplayableEvaluations += 1;
    }

    const policy = this._buildPolicy({
      mode: candidateMode,
      sampleCount: summaries.length,
      latestMs,
      p95Ms,
      maximumMs,
      nowMs: now,
    });
    this.lastPolicy = policy;
    return { ...policy, allowedWorkClasses: [...policy.allowedWorkClasses] };
  }

  _buildPolicy(summary) {
    const common = {
      ...summary,
      baselineMs: this.options.baselineMs,
      warningMs: this.options.warningMs,
      overloadMs: this.options.overloadMs,
      emergencyShedMs: this.options.emergencyShedMs,
      unplayableMs: this.options.unplayableMs,
      recoveryThresholdMs: this.options.recoveryThresholdMs,
      recoveryStartedAtMs: this.recoveryStartedAtMs,
    };
    if (summary.mode === MODE.HEALTHY) {
      return {
        ...common,
        budgetMs: this.options.healthyBudgetMs,
        maxJobs: this.options.healthyMaxJobs,
        allowedWorkClasses: Object.values(WORK_CLASS),
        reason: "tick-p95-healthy",
      };
    }
    if ([MODE.WARMING, MODE.CONSTRAINED, MODE.RECOVERING].includes(summary.mode)) {
      return {
        ...common,
        budgetMs: Math.min(0.5, this.options.healthyBudgetMs),
        maxJobs: 1,
        allowedWorkClasses: [WORK_CLASS.SETTLEMENT, WORK_CLASS.DEADLINE],
        reason: summary.mode === MODE.WARMING
          ? "waiting-for-stable-tick-window"
          : "planning-deferred-for-tick-pressure",
      };
    }
    if (summary.mode === MODE.OVERLOADED) {
      return {
        ...common,
        budgetMs: Math.min(0.25, this.options.healthyBudgetMs),
        maxJobs: 1,
        allowedWorkClasses: [WORK_CLASS.SETTLEMENT, WORK_CLASS.DEADLINE],
        reason: "sustained-overload-deadlines-only",
      };
    }
    return {
      ...common,
      budgetMs: 0,
      maxJobs: 0,
      allowedWorkClasses: [],
      reason: summary.mode === MODE.UNPLAYABLE
        ? "unplayable-circuit-breaker"
        : "emergency-background-shed",
    };
  }

  getStatus() {
    return {
      mode: this.mode,
      policy: this.lastPolicy
        ? { ...this.lastPolicy, allowedWorkClasses: [...this.lastPolicy.allowedWorkClasses] }
        : null,
      metrics: { ...this.metrics },
    };
  }
}

module.exports = {
  MODE,
  WORK_CLASS,
  XEveLoadGovernor,
  normalizeOptions,
  percentile,
};
