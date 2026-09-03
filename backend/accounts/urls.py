from django.urls import path

from accounts import views

urlpatterns = [
    path("auth/login/", views.login_view, name="auth-login"),
    path("auth/logout/", views.logout_view, name="auth-logout"),
    path("auth/me/", views.me_view, name="auth-me"),
    path("auth/password-reset/", views.password_reset_request_view,
         name="password-reset-request"),
    path("auth/password-reset/confirm/", views.password_reset_confirm_view,
         name="password-reset-confirm"),
    path("staff/", views.staff_list_view, name="staff-list"),
    path("staff/<int:membership_id>/", views.staff_detail_view, name="staff-detail"),
]
