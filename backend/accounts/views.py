"""
Auth + staff-management API.

Password reset and staff invites both use Django's own token design
(django.contrib.auth.tokens.PasswordResetTokenGenerator): the token is a
signed hash of the user's pk, password hash and a timestamp, so it is
automatically invalidated the moment the password changes or it expires
(PASSWORD_RESET_TIMEOUT, see settings.py) — nothing to store or clean up
ourselves, and it can't be reused after it's been acted on once.

The reset-request endpoint always returns the same response whether or
not the email exists, so it can't be used to enumerate staff addresses.
"""

from __future__ import annotations

from django.conf import settings
from django.contrib.auth import authenticate
from django.contrib.auth import login as django_login
from django.contrib.auth import logout as django_logout
from django.contrib.auth.tokens import default_token_generator
from django.core.mail import send_mail
from django.utils.encoding import force_bytes, force_str
from django.utils.http import urlsafe_base64_decode, urlsafe_base64_encode
from rest_framework import status
from rest_framework.decorators import api_view, permission_classes
from rest_framework.permissions import AllowAny, IsAuthenticated
from rest_framework.response import Response

from .models import Membership, User
from .permissions import RequireCapability
from .serializers import (
    InviteStaffSerializer,
    LoginSerializer,
    MeSerializer,
    PasswordResetConfirmSerializer,
    PasswordResetRequestSerializer,
    StaffListSerializer,
    UpdateMembershipSerializer,
)


def _active_membership(user, school=None):
    qs = Membership.objects.select_related("school").filter(
        user=user, is_active=True, school__is_active=True
    )
    if school is not None:
        qs = qs.filter(school=school)
    return qs.first()


def _send_credential_email(*, user, subject, intro):
    uid = urlsafe_base64_encode(force_bytes(user.pk))
    token = default_token_generator.make_token(user)
    reset_url = f"{settings.FRONTEND_URL}/reset-password?uid={uid}&token={token}"
    hours = settings.PASSWORD_RESET_TIMEOUT // 3600
    send_mail(
        subject=subject,
        message=(
            f"{intro}\n\n{reset_url}\n\n"
            f"This link works for {hours} hours. If you didn't expect this "
            f"email, you can ignore it — nothing changes until the link is used."
        ),
        from_email=settings.DEFAULT_FROM_EMAIL,
        recipient_list=[user.email],
        fail_silently=False,
    )


# ---------------------------------------------------------------------
# Login / logout / me
# ---------------------------------------------------------------------

@api_view(["POST"])
@permission_classes([AllowAny])
def login_view(request):
    serializer = LoginSerializer(data=request.data)
    serializer.is_valid(raise_exception=True)

    user = authenticate(
        request,
        username=serializer.validated_data["email"],
        password=serializer.validated_data["password"],
    )
    if user is None:
        return Response({"detail": "Incorrect email or password."},
                         status=status.HTTP_401_UNAUTHORIZED)
    if not user.is_active:
        return Response({"detail": "This account has been deactivated."},
                         status=status.HTTP_403_FORBIDDEN)

    membership = _active_membership(user)
    if membership is None:
        return Response(
            {"detail": "This account has no active school to sign in to."},
            status=status.HTTP_403_FORBIDDEN,
        )

    django_login(request, user)
    return Response(MeSerializer(user, context={"membership": membership}).data)


@api_view(["POST"])
@permission_classes([IsAuthenticated])
def logout_view(request):
    django_logout(request)
    return Response(status=status.HTTP_204_NO_CONTENT)


@api_view(["GET"])
@permission_classes([IsAuthenticated])
def me_view(request):
    membership = getattr(request, "membership", None)
    return Response(MeSerializer(request.user, context={"membership": membership}).data)


# ---------------------------------------------------------------------
# Password reset
# ---------------------------------------------------------------------

@api_view(["POST"])
@permission_classes([AllowAny])
def password_reset_request_view(request):
    serializer = PasswordResetRequestSerializer(data=request.data)
    serializer.is_valid(raise_exception=True)
    email = serializer.validated_data["email"]

    user = User.objects.filter(email__iexact=email, is_active=True).first()
    if user is not None:
        _send_credential_email(
            user=user,
            subject="Reset your Fee Portal password",
            intro="Someone asked to reset the password on this account. "
                  "If this was you, set a new password here:",
        )
    # Identical response either way — never reveal whether the address exists.
    return Response({"detail": "If that email has an account, a reset link has been sent."})


@api_view(["POST"])
@permission_classes([AllowAny])
def password_reset_confirm_view(request):
    serializer = PasswordResetConfirmSerializer(data=request.data)
    serializer.is_valid(raise_exception=True)

    try:
        uid = force_str(urlsafe_base64_decode(serializer.validated_data["uid"]))
        user = User.objects.get(pk=uid)
    except (User.DoesNotExist, ValueError, TypeError, OverflowError):
        user = None

    if user is None or not default_token_generator.check_token(
        user, serializer.validated_data["token"]
    ):
        return Response({"detail": "This reset link is invalid or has expired."},
                         status=status.HTTP_400_BAD_REQUEST)

    user.set_password(serializer.validated_data["new_password"])
    user.save(update_fields=["password"])
    return Response({"detail": "Password updated. You can sign in now."})


# ---------------------------------------------------------------------
# Staff management — owner only (manage_staff capability)
# ---------------------------------------------------------------------

@api_view(["GET", "POST"])
@permission_classes([RequireCapability("manage_staff")])
def staff_list_view(request):
    if request.method == "GET":
        memberships = (
            Membership.objects.select_related("user")
            .filter(school=request.school)
            .order_by("user__full_name", "user__email")
        )
        return Response(StaffListSerializer(memberships, many=True).data)

    serializer = InviteStaffSerializer(data=request.data)
    serializer.is_valid(raise_exception=True)
    email = serializer.validated_data["email"].strip().lower()
    full_name = serializer.validated_data.get("full_name", "")
    role = serializer.validated_data["role"]

    user, created = User.objects.get_or_create(
        email=email, defaults={"full_name": full_name}
    )
    if created:
        # No usable password until they follow the invite link — the same
        # token mechanism as a password reset doubles as "set your first
        # password", so there's no separate invite-token system to build
        # or to accidentally get out of sync with the reset flow.
        user.set_unusable_password()
        user.save(update_fields=["password"])
    elif full_name and not user.full_name:
        user.full_name = full_name
        user.save(update_fields=["full_name"])

    membership, membership_created = Membership.objects.get_or_create(
        user=user, school=request.school,
        defaults={"role": role, "invited_by": request.user},
    )
    if not membership_created:
        return Response(
            {"detail": "This person already has access to this school."},
            status=status.HTTP_409_CONFLICT,
        )

    _send_credential_email(
        user=user,
        subject=f"You've been added to {request.school.name}'s Fee Portal",
        intro=(
            f"{request.user.get_full_name()} has given you "
            f"{membership.get_role_display()} access to {request.school.name} "
            f"on the Fee Portal. Set your password to get started:"
        ),
    )
    return Response(StaffListSerializer(membership).data, status=status.HTTP_201_CREATED)


@api_view(["PATCH", "DELETE"])
@permission_classes([RequireCapability("manage_staff")])
def staff_detail_view(request, membership_id):
    membership = Membership.objects.select_related("user").filter(
        id=membership_id, school=request.school
    ).first()
    if membership is None:
        return Response(status=status.HTTP_404_NOT_FOUND)

    if membership.user_id == request.user.id:
        return Response(
            {"detail": "You can't change your own access from here."},
            status=status.HTTP_400_BAD_REQUEST,
        )

    if request.method == "DELETE":
        membership.is_active = False
        membership.save(update_fields=["is_active"])
        return Response(status=status.HTTP_204_NO_CONTENT)

    serializer = UpdateMembershipSerializer(data=request.data, partial=True)
    serializer.is_valid(raise_exception=True)
    for field, value in serializer.validated_data.items():
        setattr(membership, field, value)
    membership.save()
    return Response(StaffListSerializer(membership).data)
