# Drop pre-1.0.0 pi hosts and ship the next release as 2.0.0

Status: accepted (2026-10-03)

pi 1.0.0 turned the provider model list into a discriminated union (`chat | image | classifier`)
and added tool `exposure` plus a non-chat operation surface on providers. The 1.5.x line paid for
pre-1.0.0 hosts with a hand-written `ChatModelConfig` exclusion type and a dual-host verification
ritual, and it could not use any of the new surface. We decided to require pi >= 1.0.0 and to call
the next release 2.0.0, because dropping the old host range is the breaking change and hiding it
behind a minor would be a lie.

## Considered Options

- **Keep dual-host support and feature-detect at runtime.** Rejected: a pre-1.0.0 config has no
  `type` discriminant and no `exposure`, so image and classifier models have nowhere to live and
  the sidecar's exposure cannot be set; the shims buy nothing.
- **Require 1.0.0 but ship as 1.6.0.** Rejected: an install that used to work stops working, which
  is a major change regardless of the number on it.

## Consequences

- `ChatModelConfig` collapses to the chat member of pi's union; the exclusion-type comment goes.
- README's dual-host claim and the 0.87.0 pin in `devDependencies` are removed.
- 1.5.3 stays the last line that runs on pre-1.0.0 hosts.
