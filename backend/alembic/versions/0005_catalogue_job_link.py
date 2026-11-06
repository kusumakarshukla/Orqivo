"""Link account catalogue requests to their execution jobs."""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "0005_catalogue_job_link"
down_revision = "0004_account_state_job_link"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if not inspector.has_table("catalogue_requests"):
        raise RuntimeError("catalogue_requests table is missing.")

    columns = {column["name"] for column in inspector.get_columns("catalogue_requests")}
    if "job_id" not in columns:
        op.add_column(
            "catalogue_requests",
            sa.Column("job_id", postgresql.UUID(as_uuid=True), nullable=True),
        )
        op.create_foreign_key(
            "catalogue_requests_job_id_fkey",
            "catalogue_requests",
            "jobs",
            ["job_id"],
            ["id"],
            ondelete="SET NULL",
        )

    unique_constraints = {
        constraint["name"] for constraint in sa.inspect(bind).get_unique_constraints("catalogue_requests")
    }
    if "catalogue_requests_job_id_key" not in unique_constraints:
        op.create_unique_constraint(
            "catalogue_requests_job_id_key",
            "catalogue_requests",
            ["job_id"],
        )


def downgrade() -> None:
    op.drop_constraint("catalogue_requests_job_id_key", "catalogue_requests", type_="unique")
    op.drop_constraint("catalogue_requests_job_id_fkey", "catalogue_requests", type_="foreignkey")
    op.drop_column("catalogue_requests", "job_id")
