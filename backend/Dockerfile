FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PYTHONPATH=/app

WORKDIR /app
COPY backend/requirements.txt /app/requirements.txt
RUN apt-get update \
    && apt-get install -y --no-install-recommends gcc libkrb5-dev libkrb5-3 libgssapi-krb5-2 \
    && apt-mark manual libkrb5-3 libgssapi-krb5-2 \
    && pip install --no-cache-dir -r /app/requirements.txt \
    && apt-get purge -y --auto-remove gcc libkrb5-dev \
    && rm -rf /var/lib/apt/lists/*
COPY ansible/collections/requirements.yml /tmp/ansible-collections-requirements.yml
RUN ansible-galaxy collection install -r /tmp/ansible-collections-requirements.yml

COPY backend/app /app/app
COPY backend/alembic.ini /app/alembic.ini
COPY backend/alembic /app/alembic
COPY ansible /opt/windows-automation/ansible
RUN chmod -R go-rwx /opt/windows-automation/ansible/inventory

EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
