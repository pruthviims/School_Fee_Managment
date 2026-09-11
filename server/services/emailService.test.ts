import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sendMail } from "./emailService.js";

const ORIGINAL_ENV = { ...process.env };

function resetMailEnv() {
  delete process.env.EMAIL_HOST;
  delete process.env.EMAIL_PORT;
  delete process.env.EMAIL_HOST_USER;
  delete process.env.EMAIL_HOST_PASSWORD;
  delete process.env.DEFAULT_FROM_EMAIL;
  delete process.env.DEFAULT_FROM_NAME;
  delete process.env.BREVO_API_KEY;
}

describe("sendMail", () => {
  beforeEach(() => {
    resetMailEnv();
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("logs to the console instead of sending, when nothing is configured", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await sendMail({ to: "someone@school.test", subject: "Test", text: "Body text" });
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy.mock.calls[0][0]).toContain("someone@school.test");
    expect(logSpy.mock.calls[0][0]).toContain("Body text");
  });

  describe("Brevo HTTP API — the preferred path on a serverless deployment", () => {
    beforeEach(() => {
      process.env.BREVO_API_KEY = "xkeysib-test-key";
      process.env.DEFAULT_FROM_EMAIL = "noreply@maruthihr.co.in";
      process.env.DEFAULT_FROM_NAME = "Test School Fee Portal";
    });

    it("posts to Brevo's transactional email endpoint with the correct shape", async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ messageId: "abc123" }), { status: 201 }),
      );
      vi.stubGlobal("fetch", fetchMock);

      await sendMail({ to: "parent@example.com", subject: "Welcome", text: "Hello there" });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, options] = fetchMock.mock.calls[0];
      expect(url).toBe("https://api.brevo.com/v3/smtp/email");
      expect(options.method).toBe("POST");
      expect(options.headers["api-key"]).toBe("xkeysib-test-key");
      expect(options.headers["content-type"]).toBe("application/json");

      const body = JSON.parse(options.body);
      expect(body.sender).toEqual({ email: "noreply@maruthihr.co.in", name: "Test School Fee Portal" });
      expect(body.to).toEqual([{ email: "parent@example.com" }]);
      expect(body.subject).toBe("Welcome");
      expect(body.textContent).toBe("Hello there");
    });

    it("throws a catchable, informative error when Brevo refuses the request — never hangs, never silently fails", async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ code: "invalid_parameter", message: "Sender not verified" }),
          { status: 400 }),
      );
      vi.stubGlobal("fetch", fetchMock);

      await expect(sendMail({ to: "parent@example.com", subject: "Welcome", text: "Hi" }))
        .rejects.toThrow(/400/);
    });

    it("never falls through to the SMTP path when a Brevo key is set, even if SMTP vars are also present", async () => {
      // A school migrating from Gmail SMTP to Brevo might leave the old
      // EMAIL_HOST vars in place for a while — Brevo's HTTP API must win,
      // not silently fall back to the slower, timeout-prone SMTP path.
      process.env.EMAIL_HOST = "smtp.gmail.com";
      process.env.EMAIL_HOST_USER = "old-gmail-account@gmail.com";
      const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 201 }));
      vi.stubGlobal("fetch", fetchMock);

      await sendMail({ to: "parent@example.com", subject: "Welcome", text: "Hi" });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  describe("SMTP fallback — used only when no Brevo key is configured", () => {
    it("configures nodemailer with short timeouts well under Vercel's function limit", async () => {
      process.env.EMAIL_HOST = "smtp.gmail.com";
      process.env.EMAIL_PORT = "587";
      process.env.EMAIL_HOST_USER = "school@gmail.com";
      process.env.EMAIL_HOST_PASSWORD = "app-password";
      process.env.DEFAULT_FROM_EMAIL = "school@gmail.com";

      const sendMailMock = vi.fn().mockResolvedValue({ messageId: "smtp-id" });
      const createTransportMock = vi.fn().mockReturnValue({ sendMail: sendMailMock });
      vi.doMock("nodemailer", () => ({ default: { createTransport: createTransportMock },
        createTransport: createTransportMock }));

      await sendMail({ to: "parent@example.com", subject: "Welcome", text: "Hi" });

      expect(createTransportMock).toHaveBeenCalledTimes(1);
      const config = createTransportMock.mock.calls[0][0];
      expect(config.host).toBe("smtp.gmail.com");
      expect(config.port).toBe(587);
      expect(config.secure).toBe(false);
      // All well under Vercel's shortest function timeout (10s on
      // Hobby) — nodemailer's own defaults (2 minutes) would otherwise
      // let the function get killed mid-handshake with no catchable
      // error at all, exactly what happened before this fix.
      expect(config.connectionTimeout).toBeLessThanOrEqual(8000);
      expect(config.greetingTimeout).toBeLessThanOrEqual(8000);
      expect(config.socketTimeout).toBeLessThanOrEqual(8000);

      expect(sendMailMock).toHaveBeenCalledWith(expect.objectContaining({
        from: "school@gmail.com", to: "parent@example.com", subject: "Welcome", text: "Hi",
      }));
      vi.doUnmock("nodemailer");
    });
  });
});
