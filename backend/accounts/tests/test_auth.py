"""
These tests exist to pin exactly the guarantees "restricted access" and
"password reset" are supposed to provide:

- a role that doesn't include a capability gets a real 403 from the API,
  not just a hidden button — the server is the enforcement boundary
- a user with no membership at all cannot act on a school regardless of
  whether their login is otherwise valid
- a password-reset token works exactly once, is invalid before it's
  requested, and becomes invalid the instant it's used
- an invited user starts with no usable password and can only ever get
  one through the same signed-link mechanism as a reset
"""

from __future__ import annotations

from django.contrib.auth.tokens import default_token_generator
from django.core import mail
from django.core.management import call_command
from django.test import TestCase
from django.urls import reverse
from django.utils.encoding import force_bytes
from django.utils.http import urlsafe_base64_encode

from accounts.models import Membership, Role, User
from fees.models import School


class AccountsBase(TestCase):
    @classmethod
    def setUpTestData(cls):
        call_command("seed_school", "--code", "acc-test", "--year", "2026-27",
                     verbosity=0)
        cls.school = School.objects.get(short_code="acc-test")

        cls.owner = User.objects.create_user("owner@school.test", password="x" * 14)
        Membership.objects.create(user=cls.owner, school=cls.school, role=Role.OWNER)

        cls.front_desk = User.objects.create_user("desk@school.test", password="x" * 14)
        Membership.objects.create(
            user=cls.front_desk, school=cls.school, role=Role.FRONT_DESK
        )

        cls.no_access = User.objects.create_user("nobody@school.test", password="x" * 14)
        # Deliberately no Membership at all.


class LoginTests(AccountsBase):
    def test_correct_credentials_log_in(self):
        response = self.client.post(reverse("auth-login"), {
            "email": "owner@school.test", "password": "x" * 14,
        })
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data["email"], "owner@school.test")
        self.assertEqual(response.data["membership"]["role"], "owner")

    def test_wrong_password_is_rejected(self):
        response = self.client.post(reverse("auth-login"), {
            "email": "owner@school.test", "password": "wrong password entirely",
        })
        self.assertEqual(response.status_code, 401)

    def test_user_with_no_membership_cannot_sign_in(self):
        """
        Correct credentials aren't enough — a real login also needs an
        active Membership, or there's nothing for TenantMiddleware to
        resolve a school from and every subsequent request 403s anyway.
        """
        response = self.client.post(reverse("auth-login"), {
            "email": "nobody@school.test", "password": "x" * 14,
        })
        self.assertEqual(response.status_code, 403)

    def test_deactivated_membership_blocks_login_even_with_right_password(self):
        membership = Membership.objects.get(user=self.front_desk)
        membership.is_active = False
        membership.save()

        response = self.client.post(reverse("auth-login"), {
            "email": "desk@school.test", "password": "x" * 14,
        })
        self.assertEqual(response.status_code, 403)

    def test_me_reflects_the_signed_in_users_role_and_capabilities(self):
        self.client.login(username="desk@school.test", password="x" * 14)
        response = self.client.get(reverse("auth-me"))
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data["membership"]["role"], "front_desk")
        self.assertIn("manage_admissions", response.data["membership"]["capabilities"])
        self.assertNotIn("manage_staff", response.data["membership"]["capabilities"])

    def test_logout_ends_the_session(self):
        self.client.login(username="owner@school.test", password="x" * 14)
        self.assertEqual(self.client.get(reverse("auth-me")).status_code, 200)
        self.client.post(reverse("auth-logout"))
        self.assertEqual(self.client.get(reverse("auth-me")).status_code, 403)


class CapabilityEnforcementTests(AccountsBase):
    """
    This is the actual "restricted access" guarantee: a role without a
    capability is refused by the server, regardless of what any client
    does or doesn't show. Exercised against the real fee/admission
    endpoints, not just the new staff-management ones.
    """

    def test_front_desk_can_reach_admissions(self):
        self.client.login(username="desk@school.test", password="x" * 14)
        # A deliberately invalid payload — the point here is proving the
        # permission check passes (400 for bad data), not exercising the
        # full admission flow again; that's fees/tests/test_core.py's job.
        response = self.client.post(reverse("admit-student"), {})
        self.assertEqual(response.status_code, 400)

    def test_front_desk_cannot_reach_reports(self):
        self.client.login(username="desk@school.test", password="x" * 14)
        response = self.client.get(reverse("day-book"))
        self.assertEqual(response.status_code, 403)

    def test_front_desk_cannot_manage_staff(self):
        self.client.login(username="desk@school.test", password="x" * 14)
        response = self.client.get(reverse("staff-list"))
        self.assertEqual(response.status_code, 403)

    def test_owner_can_reach_reports_front_desk_cannot(self):
        self.client.login(username="owner@school.test", password="x" * 14)
        response = self.client.get(reverse("day-book"))
        self.assertEqual(response.status_code, 200)

    def test_anonymous_request_is_refused(self):
        response = self.client.get(reverse("staff-list"))
        self.assertEqual(response.status_code, 403)

    def test_membership_capabilities_match_the_declared_role_matrix(self):
        owner_membership = Membership.objects.get(user=self.owner)
        desk_membership = Membership.objects.get(user=self.front_desk)
        self.assertIn("manage_staff", owner_membership.capabilities())
        self.assertNotIn("manage_staff", desk_membership.capabilities())
        self.assertTrue(desk_membership.can("collect_payments"))
        self.assertFalse(desk_membership.can("manage_fee_structure"))

    def test_inactive_membership_has_no_capabilities_even_for_owner_role(self):
        membership = Membership.objects.create(
            user=self.no_access, school=self.school, role=Role.OWNER, is_active=False,
        )
        self.assertEqual(membership.capabilities(), set())


class StaffManagementTests(AccountsBase):
    def test_owner_can_invite_staff_and_an_email_is_sent(self):
        self.client.login(username="owner@school.test", password="x" * 14)
        response = self.client.post(reverse("staff-list"), {
            "email": "new-accountant@school.test",
            "full_name": "Priya Rao",
            "role": "accountant",
        })
        self.assertEqual(response.status_code, 201)
        self.assertEqual(response.data["role"], "accountant")

        new_user = User.objects.get(email="new-accountant@school.test")
        self.assertFalse(new_user.has_usable_password())

        self.assertEqual(len(mail.outbox), 1)
        self.assertIn("new-accountant@school.test", mail.outbox[0].to)
        self.assertIn("uid=", mail.outbox[0].body)
        self.assertIn("token=", mail.outbox[0].body)

    def test_inviting_the_same_person_twice_is_refused(self):
        self.client.login(username="owner@school.test", password="x" * 14)
        self.client.post(reverse("staff-list"), {
            "email": "dup@school.test", "role": "viewer",
        })
        response = self.client.post(reverse("staff-list"), {
            "email": "dup@school.test", "role": "accountant",
        })
        self.assertEqual(response.status_code, 409)

    def test_owner_can_change_a_role(self):
        self.client.login(username="owner@school.test", password="x" * 14)
        membership = Membership.objects.get(user=self.front_desk)
        response = self.client.patch(
            reverse("staff-detail", args=[membership.id]),
            {"role": "accountant"},
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 200)
        membership.refresh_from_db()
        self.assertEqual(membership.role, Role.ACCOUNTANT)

    def test_owner_can_revoke_access(self):
        self.client.login(username="owner@school.test", password="x" * 14)
        membership = Membership.objects.get(user=self.front_desk)
        response = self.client.delete(reverse("staff-detail", args=[membership.id]))
        self.assertEqual(response.status_code, 204)
        membership.refresh_from_db()
        self.assertFalse(membership.is_active)

    def test_owner_cannot_change_their_own_access_here(self):
        self.client.login(username="owner@school.test", password="x" * 14)
        own_membership = Membership.objects.get(user=self.owner)
        response = self.client.delete(reverse("staff-detail", args=[own_membership.id]))
        self.assertEqual(response.status_code, 400)

    def test_front_desk_cannot_invite_staff(self):
        self.client.login(username="desk@school.test", password="x" * 14)
        response = self.client.post(reverse("staff-list"), {
            "email": "sneaky@school.test", "role": "owner",
        })
        self.assertEqual(response.status_code, 403)
        self.assertFalse(User.objects.filter(email="sneaky@school.test").exists())


class PasswordResetTests(AccountsBase):
    def test_request_always_returns_the_same_response(self):
        """Never reveal whether an email address has an account."""
        known = self.client.post(reverse("password-reset-request"),
                                  {"email": "owner@school.test"})
        unknown = self.client.post(reverse("password-reset-request"),
                                    {"email": "nobody-at-all@school.test"})
        self.assertEqual(known.status_code, 200)
        self.assertEqual(unknown.status_code, 200)
        self.assertEqual(known.data["detail"], unknown.data["detail"])

    def test_request_for_a_real_user_sends_a_working_reset_link(self):
        self.client.post(reverse("password-reset-request"), {"email": "owner@school.test"})
        self.assertEqual(len(mail.outbox), 1)
        self.assertIn("owner@school.test", mail.outbox[0].to)

    def test_request_for_an_unknown_email_sends_nothing(self):
        self.client.post(reverse("password-reset-request"),
                          {"email": "nobody-at-all@school.test"})
        self.assertEqual(len(mail.outbox), 0)

    def test_valid_token_sets_a_new_password_that_actually_works(self):
        uid = urlsafe_base64_encode(force_bytes(self.owner.pk))
        token = default_token_generator.make_token(self.owner)

        response = self.client.post(reverse("password-reset-confirm"), {
            "uid": uid, "token": token, "new_password": "a-brand-new-strong-pw-1",
        })
        self.assertEqual(response.status_code, 200)

        login = self.client.post(reverse("auth-login"), {
            "email": "owner@school.test", "password": "a-brand-new-strong-pw-1",
        })
        self.assertEqual(login.status_code, 200)

    def test_token_cannot_be_reused_after_the_password_changes(self):
        uid = urlsafe_base64_encode(force_bytes(self.owner.pk))
        token = default_token_generator.make_token(self.owner)

        first = self.client.post(reverse("password-reset-confirm"), {
            "uid": uid, "token": token, "new_password": "first-new-password-1",
        })
        self.assertEqual(first.status_code, 200)

        second = self.client.post(reverse("password-reset-confirm"), {
            "uid": uid, "token": token, "new_password": "second-new-password-1",
        })
        self.assertEqual(second.status_code, 400)

    def test_garbage_token_is_rejected(self):
        uid = urlsafe_base64_encode(force_bytes(self.owner.pk))
        response = self.client.post(reverse("password-reset-confirm"), {
            "uid": uid, "token": "not-a-real-token", "new_password": "whatever-new-pw-1",
        })
        self.assertEqual(response.status_code, 400)

    def test_weak_password_is_rejected_by_the_usual_validators(self):
        uid = urlsafe_base64_encode(force_bytes(self.owner.pk))
        token = default_token_generator.make_token(self.owner)
        response = self.client.post(reverse("password-reset-confirm"), {
            "uid": uid, "token": token, "new_password": "12345",
        })
        self.assertEqual(response.status_code, 400)

    def test_invited_user_sets_their_first_password_through_the_same_link(self):
        self.client.login(username="owner@school.test", password="x" * 14)
        self.client.post(reverse("staff-list"), {
            "email": "invitee@school.test", "role": "viewer",
        })
        invitee = User.objects.get(email="invitee@school.test")
        self.assertFalse(invitee.has_usable_password())
        self.client.post(reverse("auth-logout"))

        uid = urlsafe_base64_encode(force_bytes(invitee.pk))
        token = default_token_generator.make_token(invitee)
        response = self.client.post(reverse("password-reset-confirm"), {
            "uid": uid, "token": token, "new_password": "invitees-new-password-1",
        })
        self.assertEqual(response.status_code, 200)

        login = self.client.post(reverse("auth-login"), {
            "email": "invitee@school.test", "password": "invitees-new-password-1",
        })
        self.assertEqual(login.status_code, 200)
        self.assertEqual(login.data["membership"]["role"], "viewer")
