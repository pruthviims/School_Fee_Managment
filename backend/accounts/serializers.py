from __future__ import annotations

from django.contrib.auth import password_validation
from rest_framework import serializers

from .models import Membership, Role, User


class MembershipSerializer(serializers.ModelSerializer):
    capabilities = serializers.SerializerMethodField()

    class Meta:
        model = Membership
        fields = ["id", "role", "is_active", "capabilities"]

    def get_capabilities(self, obj):
        return sorted(obj.capabilities())


class MeSerializer(serializers.ModelSerializer):
    """
    The frontend's single source of truth for "what am I allowed to do" —
    read once at login/app-load and used to decide what to show, while the
    server-side permission classes remain the actual enforcement.
    """

    membership = serializers.SerializerMethodField()

    class Meta:
        model = User
        fields = ["id", "email", "full_name", "membership"]

    def get_membership(self, obj):
        membership = self.context.get("membership")
        return MembershipSerializer(membership).data if membership else None


class LoginSerializer(serializers.Serializer):
    email = serializers.EmailField()
    password = serializers.CharField(write_only=True, trim_whitespace=False)


class StaffListSerializer(serializers.ModelSerializer):
    user_id = serializers.IntegerField(source="user.id", read_only=True)
    email = serializers.EmailField(source="user.email", read_only=True)
    full_name = serializers.CharField(source="user.full_name", read_only=True)
    capabilities = serializers.SerializerMethodField()

    class Meta:
        model = Membership
        fields = [
            "id", "user_id", "email", "full_name", "role", "is_active",
            "capabilities", "created_at",
        ]

    def get_capabilities(self, obj):
        return sorted(obj.capabilities())


class InviteStaffSerializer(serializers.Serializer):
    email = serializers.EmailField()
    full_name = serializers.CharField(max_length=150, allow_blank=True, required=False)
    role = serializers.ChoiceField(choices=Role.choices)


class UpdateMembershipSerializer(serializers.Serializer):
    role = serializers.ChoiceField(choices=Role.choices, required=False)
    is_active = serializers.BooleanField(required=False)

    def validate(self, attrs):
        if not attrs:
            raise serializers.ValidationError("Nothing to update.")
        return attrs


class PasswordResetRequestSerializer(serializers.Serializer):
    email = serializers.EmailField()


class PasswordResetConfirmSerializer(serializers.Serializer):
    uid = serializers.CharField()
    token = serializers.CharField()
    new_password = serializers.CharField(write_only=True, trim_whitespace=False)

    def validate_new_password(self, value):
        # Same validators as everywhere else in Django — minimum length,
        # not-too-common, not-all-numeric, not the same as the user's
        # other identifying fields. See AUTH_PASSWORD_VALIDATORS.
        password_validation.validate_password(value)
        return value
