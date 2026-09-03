"""
DRF permission classes built on Membership capabilities.

This is the real enforcement boundary. A restriction that only hides a
button in the browser isn't a restriction at all — anyone with dev tools
open can call the API directly — so every capability check has to live
here, on the server, regardless of what the frontend does or doesn't show.

request.membership is set by fees.middleware.TenantMiddleware from
request.user's active Membership for the resolved school. It's None for
anonymous users and for users with no (active) membership at all, so both
cases are denied by construction rather than needing a separate check.
"""

from __future__ import annotations

from rest_framework.permissions import BasePermission


class IsMember(BasePermission):
    """Any active role at the resolved school — the baseline for read access."""

    message = "You don't have access to this school."

    def has_permission(self, request, view):
        return bool(getattr(request, "membership", None))


def RequireCapability(capability: str):
    """
    Usage: permission_classes = [RequireCapability("manage_staff")]

    A factory rather than a plain class because DRF permission_classes are
    instantiated with no arguments — this returns a class closed over the
    capability name, which DRF then instantiates normally.
    """

    class _RequireCapability(BasePermission):
        message = f"Your role doesn't include '{capability}'."

        def has_permission(self, request, view):
            membership = getattr(request, "membership", None)
            return bool(membership and membership.can(capability))

    _RequireCapability.__name__ = f"RequireCapability_{capability}"
    return _RequireCapability
