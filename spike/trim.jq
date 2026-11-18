# Trimmed run_end: drop URLs/paths/tokens, keep verdict essentials.
select(.type=="run_end") | {status, one_liner, duration, credits_consumed, result_code, reason_code,
  variables: ((.context.variables // {}) | with_entries(.value |= .value)),
  condition_results, verdict_status: .verdict.status, verdict_category: .verdict.category, verdict_credits: .verdict.credits_consumed}
| with_entries(select(.value != null))
