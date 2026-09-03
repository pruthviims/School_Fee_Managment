"""
Tenant resolution.

Which school a request acts on is resolved from the signed-in user's
active Membership (accounts.models.Membership), never guessed. A user
with no active membership gets request.school = None, and every view that
needs a school either 404s or is denied by a permission class in
accounts/permissions.py — there is no fallback to "the only school",
because there no longer is exactly one.

The Postgres session variable is set for the RLS policies in sql/rls.sql
to become the real enforcement boundary once this runs against Postgres
instead of the SQLite fallback used for the test suite.
"""

from django.db import connection

from accounts.models import Membership


class TenantMiddleware:
    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        request.school = None
        request.school_id = None
        request.membership = None

        if request.user.is_authenticated:
            membership = (
                Membership.objects.select_related("school")
                .filter(user=request.user, is_active=True, school__is_active=True)
                .first()
            )
            if membership is not None:
                request.membership = membership
                request.school = membership.school
                request.school_id = membership.school_id

        if request.school_id and connection.vendor == "postgresql":
            with connection.cursor() as cur:
                cur.execute("SELECT set_config('app.school_id', %s, true)",
                            [str(request.school_id)])

        return self.get_response(request)
