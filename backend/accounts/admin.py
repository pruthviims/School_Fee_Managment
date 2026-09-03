from django.contrib import admin
from django.contrib.auth.admin import UserAdmin as DjangoUserAdmin

from .models import Membership, User


@admin.register(User)
class UserAdmin(DjangoUserAdmin):
    """
    Mirrors Django's built-in UserAdmin but adapted for an email-only,
    username-less user model — the default UserAdmin assumes `username`
    exists, which this model deliberately doesn't have.
    """
    ordering = ["email"]
    list_display = ["email", "full_name", "is_active", "is_staff"]
    search_fields = ["email", "full_name"]
    fieldsets = (
        (None, {"fields": ("email", "password")}),
        ("Personal info", {"fields": ("full_name",)}),
        ("Permissions", {"fields": ("is_active", "is_staff", "is_superuser",
                                     "groups", "user_permissions")}),
        ("Important dates", {"fields": ("last_login", "date_joined")}),
    )
    add_fieldsets = (
        (None, {"classes": ("wide",),
                "fields": ("email", "full_name", "password1", "password2")}),
    )


@admin.register(Membership)
class MembershipAdmin(admin.ModelAdmin):
    list_display = ["user", "school", "role", "is_active", "created_at"]
    list_filter = ["role", "is_active", "school"]
    search_fields = ["user__email", "user__full_name", "school__name"]
    autocomplete_fields = ["user", "school", "invited_by"]
