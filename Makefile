.PHONY: setup dev migrate seed test lint ansible-check docker-up docker-down

setup:
	bash scripts/setup_linux.sh

dev:
	bash scripts/run_development.sh

migrate:
	cd backend && ../.venv/bin/alembic upgrade head

seed:
	cd backend && PYTHONPATH=. ../.venv/bin/python -m app.seed

test:
	cd backend && PYTHONPATH=. ../.venv/bin/python -m pytest

lint:
	python -m compileall -q backend/app
	pnpm run typecheck

ansible-check:
	bash scripts/verify_setup.sh --ansible-only

docker-up:
	docker compose up --build -d

docker-down:
	docker compose down
