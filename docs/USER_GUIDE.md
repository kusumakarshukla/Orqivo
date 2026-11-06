# User guide

## Sign in

The initial portal includes three development-only roles. Use the account email shown on the login page and a password configured by the project administrator. Development passwords are not displayed in the UI.

## Run an approved automation

1. Open **Automations** and review risk, target OS, required role, and expected time.
2. Open **Run**, choose the approved automation and active registered server.
3. Complete all dynamic parameters, change reference (when required), and business reason.
4. Review the request and confirm it before submission.
5. Open the returned job ID to track status, timeline, and sanitized output.

## Execute an account-creation request

When the administrator has enabled the non-production account demo, submitting a permanent or consultant account request queues it for the configured demo OU. Open **Job History**, expand the request in **TechHub catalogue requests**, and use **View job** to track it. Requests submitted before execution was enabled remain available there as **Submitted for Review**; use **Queue account creation** to queue one after reviewing its details. The action is available only when demo execution, the registered non-production target, and the worker are configured. Do not use this flow for production accounts.

## History and logs

Use Job History filters to find prior runs. Viewers can see only their own jobs. Operators can download sanitized logs and retry failed or timed-out jobs where permitted. CSV export includes sanitized fields only.

## Admin tasks

Admins can maintain registered targets and allowlisted automation definitions, test connections, and review audit events. Admin configuration does not allow raw commands or arbitrary script/playbook paths.
