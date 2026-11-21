# Security

Please report vulnerabilities privately.

## Supported versions

During 0.x only the latest release gets fixes. A fix ships as a patch on top of the latest minor;
older 0.x lines are not patched. From 1.0 on, the latest minor of the current major gets fixes, and
the previous major gets security fixes for six months after the next one is released.

| Version | Security fixes |
|---|---|
| Latest 0.x release | Yes |
| Older 0.x releases | No |

## Reporting

Use GitHub's private vulnerability reporting for this repository:
<https://github.com/noctcore/jobs/security/advisories/new>. It opens a draft advisory that only the
maintainer can see.

If that page says reporting is not enabled, open a regular issue whose entire body is "security
report, need a private channel", with no details, and the maintainer will reply with one.

Include the version, what an attacker needs, and what they get. There is no bounty. You get a
reply, a fix released as a patch with a changelog entry that credits you unless you ask otherwise,
and the details published once consumers have had the fix for a day.

## How a report is handled

1. **Acknowledged** within 3 working days, in the draft advisory.
2. **Triaged**: in scope or not, severity (CVSS), affected versions. You hear the outcome and the
   reasoning either way.
3. **Fixed in private**, in a temporary private fork attached to the advisory, with a test that
   fails before the fix.
4. **Released** as a patch with a changeset that describes the impact.
5. **Published** once consumers have had the fixed release for a day.

## What counts

- A job payload, dedupe key or context field that reaches Redis, logs, spans or error reports in a
  form the docs say it does not (dedupe keys are documented as stored only as SHA-256 hashes).
- A crafted job (written by anything with Redis write access, or replayed from a queue UI) that
  makes the worker run with a context the producer did not send, or crash the process.
- A credential in `redisUrl` that ends up in a log line or an error message.
- The published artefacts: a tarball on npm that does not match the tagged source, or a way to make
  the release workflow publish something else.

## What does not count

- Anything that needs Redis write access to do something BullMQ itself allows with it (deleting
  jobs, changing their data). Protect Redis with a password, TLS and a private network.
- Configuration the app chose (a long retention, a large concurrency).
- Advisories in the dev toolchain that never ship in the published `dist/`.

## Versioning policy

Weakening a default or removing a check is a major change from 1.0 and a minor change with a
"Behaviour change" note during 0.x. Fixes are patches. During 0.x, pin exact versions.
