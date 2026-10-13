# Security policy

## Reporting a vulnerability

Please report a vulnerability in Brody privately:

<https://github.com/MoRohn/brody/security/advisories/new>

Do not open a public issue, and do not include exploit details in a pull request, for a problem that would let someone execute imported code, read another project, or steal a stored credential.

Include what you expected, what happened, the Brody commit you ran, and whether you used Docker or a local checkout. There is no published email address and no bug-bounty program. The maintainer will acknowledge a report when they can; please allow several days.

## What Brody treats as a vulnerability

Imported code is untrusted data and must never be executed. A bug that runs repository code, repository config, or model-written Lean that the source screen is supposed to refuse is in scope. So is a bug that leaks a GitHub token, an API key, or a secret Brody had already redacted, or that lets one request read a project the operator did not open.

## What is already the design

These are documented limits, not undisclosed vulnerabilities:

* There is no user authentication. Brody is single-tenant. Anyone who can reach the port can read every project. Run it on loopback, or behind an authenticating reverse proxy. Do not put it on the open internet.
* Brody does not look up dependency CVEs, and it does not claim to be a legal privacy assessment.
* Formal proofs are about a model of a function. Lean checks the proof; a separate audit checks the model.

The operational details are in the README's security model and in `src/lib/formal/lean.ts`.

## Supported versions

Security fixes land on `main`. There are no older release branches.
