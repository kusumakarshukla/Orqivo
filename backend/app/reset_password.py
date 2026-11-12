from getpass import getpass

from sqlalchemy import select

from app.core.config import settings, validate_production_admin_password
from app.core.security import hash_password
from app.db.models import User
from app.db.session import SessionLocal

MIN_PASSWORD_LENGTH = 14


def main() -> None:
    email = input("Account email to reset: ").strip().lower()
    if not email:
        raise SystemExit("An account email is required.")

    password = getpass("New password (minimum 14 characters): ")
    if len(password.strip()) < MIN_PASSWORD_LENGTH:
        raise SystemExit(f"Password must be at least {MIN_PASSWORD_LENGTH} characters.")
    if password != getpass("Confirm new password: "):
        raise SystemExit("Passwords do not match.")

    with SessionLocal.begin() as db:
        user = db.scalar(select(User).where(User.email == email))
        if user is None:
            raise SystemExit(f"No account found for {email}.")
        if settings.app_env == "production" and email == "admin@example.com":
            validate_production_admin_password(password)
            if password != settings.dev_admin_password:
                raise SystemExit(
                    "For the seeded production admin, use the same password configured as DEV_ADMIN_PASSWORD."
                )
        user.password_hash = hash_password(password)

    print(f"Password updated for {email}.")


if __name__ == "__main__":
    main()
