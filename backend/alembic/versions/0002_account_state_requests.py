"""Add intake-only Active Directory account state requests."""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "0002_account_state_requests"
down_revision = "0001_initial_schema"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)

    if inspector.has_table("account_state_requests"):
        columns = {column["name"] for column in inspector.get_columns("account_state_requests")}
        expected_columns = {
            "id", "action", "sam_account_name", "requested_by_user_id", "status", "submitted_at"
        }
        if not expected_columns.issubset(columns):
            raise RuntimeError("Existing account_state_requests table has an unexpected schema.")
    else:
        op.create_table(
            "account_state_requests",
            sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
            sa.Column("action", sa.String(length=40), nullable=False),
            sa.Column("sam_account_name", sa.String(length=20), nullable=False),
            sa.Column("requested_by_user_id", postgresql.UUID(as_uuid=True), nullable=False),
            sa.Column("status", sa.String(length=40), nullable=False),
            sa.Column("submitted_at", sa.DateTime(timezone=True), nullable=False),
            sa.ForeignKeyConstraint(["requested_by_user_id"], ["users.id"], ondelete="RESTRICT"),
            sa.PrimaryKeyConstraint("id"),
        )

    index_names = {
        index["name"] for index in sa.inspect(bind).get_indexes("account_state_requests")
    }
    if "account_state_requests_submitted_idx" not in index_names:
        op.create_index(
            "account_state_requests_submitted_idx",
            "account_state_requests",
            ["submitted_at"],
        )
    if "account_state_requests_requester_idx" not in index_names:
        op.create_index(
            "account_state_requests_requester_idx",
            "account_state_requests",
            ["requested_by_user_id"],
        )


def downgrade() -> None:
    op.drop_index("account_state_requests_requester_idx", table_name="account_state_requests")
    op.drop_index("account_state_requests_submitted_idx", table_name="account_state_requests")
    op.drop_table("account_state_requests")
