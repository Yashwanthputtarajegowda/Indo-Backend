# Security Policy

## Reporting a vulnerability

Please do not disclose security vulnerabilities in public issues.

Report a suspected vulnerability privately to the repository owner and include:

- a clear description of the issue
- affected endpoint or component
- reproduction steps
- security impact
- any suggested mitigation

Do not include real credentials, private keys, tokens, or user data in a report.

## Security expectations

Production secrets must remain in deployment secret storage and environment variables, never in source control. Authentication and authorization are enforced server-side. Changes that affect authentication, authorization, uploads, media ownership, or data access should be tested before deployment.
