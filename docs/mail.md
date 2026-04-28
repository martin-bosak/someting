# Mail Hosting Decision

Do not self-host full mailbox service in the first version of this VPS platform. Web hosting and mail hosting have different operational risks, and mail deliverability is usually the harder problem.

## Recommended Modes

## External Mailbox Provider

Use this for real inboxes. Good fits include Migadu, Fastmail, Proton, Google Workspace, or another provider you trust. Configure MX, SPF, DKIM, and DMARC at your DNS provider.

## SMTP Relay

Use this when apps only need to send email. Providers such as Postmark, Mailgun, Brevo, Amazon SES, or SMTP2GO avoid VPS IP reputation problems.

## Forwarding Only

Use this for aliases like `hello@example.com` forwarding to an existing mailbox. Prefer a provider-managed forwarding service first.

## Self-Hosted Mail

Only choose this later if you explicitly want to maintain:

- Reverse DNS.
- SPF, DKIM, and DMARC.
- Spam filtering.
- TLS certificates.
- Mailbox backups.
- Blocklist/reputation monitoring.

If self-hosting becomes a requirement, run it as a separate Compose stack and reserve enough RAM/disk for spam filtering and mail storage.

## Management App Scope

The management app stores mail notes so each domain has a recorded decision: external, forwarding, SMTP relay, or self-hosted. It does not run an SMTP/IMAP service in this MVP.
