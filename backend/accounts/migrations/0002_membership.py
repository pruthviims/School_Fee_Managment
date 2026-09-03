import django.db.models.deletion
import django.utils.timezone
from django.conf import settings
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("accounts", "0001_initial"),
        ("fees", "0001_initial"),
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
    ]

    operations = [
        migrations.CreateModel(
            name="Membership",
            fields=[
                ("id", models.BigAutoField(primary_key=True, serialize=False)),
                ("role", models.CharField(choices=[
                    ("owner", "Owner"), ("accountant", "Accountant"),
                    ("front_desk", "Front desk"), ("viewer", "Viewer"),
                ], max_length=20)),
                ("is_active", models.BooleanField(
                    default=True,
                    help_text="Revoke access without losing the audit trail of what "
                              "this person did while they had it.")),
                ("created_at", models.DateTimeField(default=django.utils.timezone.now)),
                ("invited_by", models.ForeignKey(
                    blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL,
                    related_name="+", to=settings.AUTH_USER_MODEL)),
                ("school", models.ForeignKey(
                    on_delete=django.db.models.deletion.CASCADE,
                    related_name="memberships", to="fees.school")),
                ("user", models.ForeignKey(
                    on_delete=django.db.models.deletion.CASCADE,
                    related_name="memberships", to=settings.AUTH_USER_MODEL)),
            ],
        ),
        migrations.AddConstraint(
            model_name="membership",
            constraint=models.UniqueConstraint(
                fields=("user", "school"), name="uniq_membership_per_user_school"
            ),
        ),
    ]
