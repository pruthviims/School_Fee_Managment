"""
Authentication and per-school access control.

A User is a login identity, global to the whole system (one person could
in principle work across schools, though today's frontend only ever deals
with one). Membership is what actually grants access: it ties a User to
one School with one Role, and is what TenantMiddleware resolves the active
school from — see fees/middleware.py. A user with no Membership for a
school has no access to it at all, regardless of whether their login is
otherwise valid.

Role is a fixed set of capability bundles rather than a granular
permission-per-checkbox system. A school office wants to say "Priya is
front desk" and be done with it, not configure a permissions matrix. If a
school ever needs finer granularity than these four roles, that's a sign
this needs Django's Group/Permission system layered on top, not more enum
values here.
"""

from __future__ import annotations

from django.contrib.auth.base_user import AbstractBaseUser, BaseUserManager
from django.contrib.auth.models import PermissionsMixin
from django.db import models
from django.utils import timezone


class UserManager(BaseUserManager):
    use_in_migrations = True

    def _create_user(self, email, password, **extra_fields):
        if not email:
            raise ValueError("Users must have an email address.")
        email = self.normalize_email(email)
        user = self.model(email=email, **extra_fields)
        user.set_password(password)
        user.save(using=self._db)
        return user

    def create_user(self, email, password=None, **extra_fields):
        extra_fields.setdefault("is_staff", False)
        extra_fields.setdefault("is_superuser", False)
        return self._create_user(email, password, **extra_fields)

    def create_superuser(self, email, password=None, **extra_fields):
        extra_fields.setdefault("is_staff", True)
        extra_fields.setdefault("is_superuser", True)
        if extra_fields.get("is_staff") is not True:
            raise ValueError("Superuser must have is_staff=True.")
        if extra_fields.get("is_superuser") is not True:
            raise ValueError("Superuser must have is_superuser=True.")
        return self._create_user(email, password, **extra_fields)


class User(AbstractBaseUser, PermissionsMixin):
    """
    Login is by email, not username — nobody at a front desk wants to
    remember a separate username on top of everything else. is_staff /
    is_superuser (from PermissionsMixin) gate the Django admin site only;
    day-to-day access control within a school runs entirely through
    Membership.role below, not through these flags.
    """

    email = models.EmailField(unique=True)
    full_name = models.CharField(max_length=150, blank=True)
    is_active = models.BooleanField(
        default=True,
        help_text="Unchecking this blocks login without deleting the account "
                   "or the history of what it did.",
    )
    is_staff = models.BooleanField(
        default=False, help_text="Django admin site access. Unrelated to school roles.",
    )
    date_joined = models.DateTimeField(default=timezone.now)

    objects = UserManager()

    USERNAME_FIELD = "email"
    REQUIRED_FIELDS: list[str] = []

    def __str__(self):
        return self.full_name or self.email

    def get_full_name(self):
        return self.full_name or self.email

    def get_short_name(self):
        return self.full_name.split(" ")[0] if self.full_name else self.email


class Role(models.TextChoices):
    OWNER = "owner", "Owner"
    ACCOUNTANT = "accountant", "Accountant"
    FRONT_DESK = "front_desk", "Front desk"
    VIEWER = "viewer", "Viewer"


# Capability flags per role — the single source of truth both the API
# permission classes (accounts/permissions.py) and the /api/auth/me/
# response read from. Change what a role can do here, nowhere else, so
# the server-side check and whatever the frontend shows can never drift
# apart from each other.
ROLE_CAPABILITIES: dict[str, set[str]] = {
    Role.OWNER: {
        "manage_staff", "manage_fee_structure", "manage_transport",
        "manage_admissions", "collect_payments", "manage_concessions",
        "view_reports", "edit_school_profile",
    },
    Role.ACCOUNTANT: {
        "manage_fee_structure", "manage_transport", "collect_payments",
        "manage_concessions", "view_reports",
    },
    Role.FRONT_DESK: {
        "manage_admissions", "collect_payments",
    },
    Role.VIEWER: {
        "view_reports",
    },
}


class Membership(models.Model):
    """One row per (user, school): what that person can do at that school."""

    id = models.BigAutoField(primary_key=True)
    user = models.ForeignKey(
        "accounts.User", on_delete=models.CASCADE, related_name="memberships"
    )
    school = models.ForeignKey(
        "fees.School", on_delete=models.CASCADE, related_name="memberships"
    )
    role = models.CharField(max_length=20, choices=Role.choices)
    is_active = models.BooleanField(
        default=True,
        help_text="Revoke access without losing the audit trail of what this "
                   "person did while they had it.",
    )
    invited_by = models.ForeignKey(
        "accounts.User", null=True, blank=True,
        on_delete=models.SET_NULL, related_name="+",
    )
    created_at = models.DateTimeField(default=timezone.now)

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["user", "school"], name="uniq_membership_per_user_school"
            ),
        ]

    def __str__(self):
        return f"{self.user} @ {self.school} ({self.role})"

    def capabilities(self) -> set[str]:
        if not self.is_active:
            return set()
        return ROLE_CAPABILITIES.get(self.role, set())

    def can(self, capability: str) -> bool:
        return capability in self.capabilities()
