# Audit rubric

Use applicable requirements, not a universal folder template. There is no
general rule that bans ADRs, Markdown or agent context from a code repository.

| Boundary | Questions and evidence |
| --- | --- |
| Architecture | Are module responsibilities clear? Are dependencies directed? Do authorization, writes and recovery have one owner? Compare accepted decisions with actual call paths. Identify speculative abstraction and hidden host/provider assumptions. |
| Documentation | Which document owns current truth? Are old ADRs superseded explicitly? Does user documentation match commands and behavior? Separate shared project rules from private incidents and generated logs. Check consumers before recommending moves. |
| Privacy | Inspect tracked content and distributable package lists separately. Ignore rules do not remove tracked files or history. Treat paths and operational history as context to classify, not automatic proof of secret leakage. Redact sensitive values in evidence. |
| Dependencies | Verify upstream source, licence notices, lock files, generated inputs, refresh procedure and patch ownership. Large fixtures can be legitimate. A provenance hash proves correspondence, not safety or maintenance quality. |
| Tests | Connect requirements to behavioral tests. Inspect assertions, skips, fixture realism and failure injection. Distinguish source, installed-package, real-browser and real-provider evidence. Coverage percentages do not prove correctness. |
| Operations | Inspect configuration boundaries, upgrades, state compatibility, rollback, concurrency, restart and interrupted-network behavior. Do not exercise live credentials or writers by default. |
| Review | Pin scope and track every changed path. Separate inherited backlog from new work. Record reviewer limits and skipped tools. Do not infer complete review from green CI or a generic bot response. |

## Documentation disposition

- Keep ADRs, public contracts, setup instructions and meaningful technical tests.
- Keep agent context if it is portable, maintained and points to canonical docs.
- Move personal operations and project-specific private planning to the existing
  private project space after authorization. Preserve links and source history.
- Store bulky generated logs as CI artifacts where retention is sufficient.
  Retain concise durable evidence indexes when required for decisions.
- Archive superseded decisions with a link to their replacement. Do not erase
  rationale or approved history because the implementation has evolved.
- Delete only verified redundant/generated material after checking consumers
  and obtaining the required authorization. Do not propose a rewrite by default.

## Severity and verifier

Reuse code-review's critical/major/minor/suggestion definitions. A large PR or
an unconventional directory is not itself a defect. A violated trust boundary,
unsafe distribution or false support claim needs concrete evidence and impact.
Missing review coverage is a separate limitation, not an invented code finding.
For each candidate, cite the pinned path/line, applicable rule, consequence,
smallest correction and meaningful validation. State uncertainty explicitly.

## External guidance

Verify current primary sources when needed. Do not claim formal compliance
from using a checklist. Do not import a source's unrelated requirements (for
example, English-only comments) into a multilingual product.

- Google engineering review: https://google.github.io/eng-practices/review/reviewer/looking-for.html
- Google change size: https://google.github.io/eng-practices/review/developer/small-cls.html
- AWS ADR lifecycle: https://docs.aws.amazon.com/prescriptive-guidance/latest/architectural-decision-records/best-practices.html
- NIST SSDF: https://csrc.nist.gov/pubs/sp/800/218/final
