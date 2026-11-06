"""Create the initial portal schema."""
from alembic import op

from app.db.models import Base

revision = "0001_initial_schema"
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Base metadata is the canonical initial schema. Future revisions should
    # use explicit Alembic operations for incremental, reviewable changes.
    initial_tables = [
        table for table in Base.metadata.sorted_tables
        if table.name not in {"account_state_requests", "catalogue_requests"}
    ]
    Base.metadata.create_all(bind=op.get_bind(), tables=initial_tables)


def downgrade() -> None:
    Base.metadata.drop_all(bind=op.get_bind())
