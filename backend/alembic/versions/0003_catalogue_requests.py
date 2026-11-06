"""Add persistent intake requests for the TechHub catalogues."""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "0003_catalogue_requests"
down_revision = "0002_account_state_requests"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if inspector.has_table("catalogue_requests"):
        columns = {column["name"] for column in inspector.get_columns("catalogue_requests")}
        expected_columns = {
            "id", "catalogue", "request_data", "requested_by_user_id", "status", "submitted_at"
        }
        if not expected_columns.issubset(columns):
            raise RuntimeError("Existing catalogue_requests table has an unexpected schema.")
    else:
        op.create_table(
            "catalogue_requests",
            sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
            sa.Column("catalogue", sa.String(length=60), nullable=False),
            sa.Column("request_data", sa.JSON(), nullable=False),
            sa.Column("requested_by_user_id", postgresql.UUID(as_uuid=True), nullable=False),
            sa.Column("status", sa.String(length=40), nullable=False),
            sa.Column("submitted_at", sa.DateTime(timezone=True), nullable=False),
            sa.ForeignKeyConstraint(["requested_by_user_id"], ["users.id"], ondelete="RESTRICT"),
            sa.PrimaryKeyConstraint("id"),
        )

    index_names = {index["name"] for index in sa.inspect(bind).get_indexes("catalogue_requests")}
    indexes = {
        "catalogue_requests_submitted_idx": ["submitted_at"],
        "catalogue_requests_requester_idx": ["requested_by_user_id"],
        "catalogue_requests_catalogue_idx": ["catalogue"],
    }
    for index_name, columns in indexes.items():
        if index_name not in index_names:
            op.create_index(index_name, "catalogue_requests", columns)


def downgrade() -> None:
    op.drop_index("catalogue_requests_catalogue_idx", table_name="catalogue_requests")
    op.drop_index("catalogue_requests_requester_idx", table_name="catalogue_requests")
    op.drop_index("catalogue_requests_submitted_idx", table_name="catalogue_requests")
    op.drop_table("catalogue_requests")
