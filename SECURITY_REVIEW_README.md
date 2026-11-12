# Security Review Change Log

This file records the changes made to prepare Orqivo for security-team review.

## Confirmed finding addressed

| Severity | Finding | Resolution |
|---|---|---|
| HIGH | Seeded accounts had known default passwords, including `admin`, and production accepted those defaults. | Removed all seeded password defaults. Production startup and seeding now require an explicitly configured admin password of at least 14 characters and reject known placeholders. |
| HIGH | A tracked environment-copy file contained live-looking Windows, database, session, CSRF, and seeded-user credentials. | Removed the tracked environment copy, ignored future `.env*` files other than `.env.example`, and replaced the example with blank secret values. Treat any credentials that were valid as compromised and rotate them; deleting a file does not erase it from Git history. |

## Changes made

- `backend/app/core/config.py`: Removed password defaults for the seeded admin, operator, and viewer; added a production admin-password validator.
- `backend/app/main.py`: Fail production API startup if the admin password is missing, too short, a known placeholder, or does not match the stored seeded admin password.
- `backend/app/seed.py`: Apply the production password requirement before seeding. In production, synchronize built-in password hashes to the configured values; accounts without configured passwords cannot use password login.
- `backend/app/reset_password.py`: Added an interactive account password reset command. Password entry is hidden and never passed in shell arguments; new passwords must be at least 14 characters.
- `.env.example`: Removed usable session, CSRF, database, Windows username, and seeded-user password examples. Set mock mode on and Ansible off by default.
- `.gitignore`: Ignore `.env*` files except the explicitly safe `.env.example`.
- `.env copy`: Removed the tracked environment copy containing credentials.
- `README.md` and `docs/DEPLOYMENT.md`: Document explicit secret configuration and password recovery.
- `SECURITY_REVIEW_README.md`: Added this requested change record and password recovery guidance.

## Secure password setup and recovery

1. Store secrets in an approved secret manager or a root-owned environment file with restrictive permissions. Do not commit `.env` or paste secrets into chat, tickets, or shell commands.
2. Set `DEV_ADMIN_PASSWORD` to a unique passphrase of at least 14 characters. Set unique values for any operator/viewer accounts that need password login.
3. Before starting production API containers, run migrations and the production seed after setting the protected environment values. This updates existing built-in accounts away from any legacy default password.
4. To reset an account without putting the password in shell history, run this from the Compose project directory:

   ```bash
   sudo docker compose run --rm -it api python -m app.reset_password
   ```

   Enter the account email and new password at the prompts. The password is not echoed or placed in shell history. For the seeded production admin, the entered value must match `DEV_ADMIN_PASSWORD`; update the protected environment first if rotating it.
5. Restart the API after changing the protected environment:

   ```bash
   sudo docker compose up -d --force-recreate api
   ```

This is a credential reset procedure for an authorized VM/database operator, not a bypass of authentication. Access to the VM and database must remain restricted and audited.

## Credential exposure response

The removed tracked environment copy may remain in repository history, clones, and backups. Immediately rotate any credentials from it that were or may have been valid, including the Windows automation identity, database password, session/CSRF secrets, and seeded user passwords. Invalidate existing portal sessions by rotating session/CSRF secrets. Ask the repository administrator to follow the organization's secret-removal/history-cleanup process and coordinate affected clones; do not assume deleting the current file removes historical copies.

## Validation status

- Python syntax compilation passed for the changed backend modules.
- Changed application modules imported successfully in a temporary environment with the backend runtime dependencies needed for those imports.
- Focused admin-password policy checks passed for missing, short, known-placeholder, and long passphrase values.
- `git diff --check` passed.
- Installing every backend requirement on the local Python 3.14/macOS environment could not complete because the pinned cryptography range attempted a source build and OpenSSL development files were unavailable. This is a local validation-environment limitation; the deployment image uses Python 3.12.
- No repository Python test files were present, and no production deployment or penetration test was run.

Existing unrelated working-tree modifications to the Ansible account playbooks were not changed as part of this review.
