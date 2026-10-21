import hashlib
import hmac
import re
import secrets

from app.core.config import settings

SECRET_FIELD = re.compile(r"password|secret|token|credential|authorization|(?:^|_)key(?:$|_)", re.I)


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    digest = hashlib.scrypt(password.encode("utf-8"), salt=salt, n=2**14, r=8, p=1)
    return f"scrypt${salt.hex()}${digest.hex()}"


def verify_password(password: str, encoded: str) -> bool:
    try:
        scheme, salt_hex, expected = encoded.split("$", 2)
        if scheme != "scrypt":
            return False
        actual = hashlib.scrypt(password.encode("utf-8"), salt=bytes.fromhex(salt_hex), n=2**14, r=8, p=1)
        return hmac.compare_digest(actual.hex(), expected)
    except (ValueError, TypeError):
        return False


def digest_token(token: str) -> str:
    return hmac.new(settings.session_secret.encode("utf-8"), token.encode("utf-8"), hashlib.sha256).hexdigest()


def sanitize_text(value: object) -> str:
    text = str(value or "")
    text = re.sub(r"(ansible_password|password|secret|token|authorization|credential)\s*[:=]\s*([^\s,;]+)", r"\1=[REDACTED]", text, flags=re.I)
    text = re.sub(r"(Bearer\s+)[A-Za-z0-9._~+/-]+=*", r"\1[REDACTED]", text, flags=re.I)
    return text[:12000]


def sanitize_json(value: object) -> object:
    if isinstance(value, list):
        return [sanitize_json(item) for item in value]
    if isinstance(value, dict):
        return {
            key: "[REDACTED]" if SECRET_FIELD.search(key) else sanitize_json(item)
            for key, item in value.items()
        }
    return sanitize_text(value) if isinstance(value, str) else value


def new_session_token() -> str:
    return secrets.token_urlsafe(48)
