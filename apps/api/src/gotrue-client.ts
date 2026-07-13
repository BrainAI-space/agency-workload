interface GoTrueUser {
  id: string;
  email?: string;
  banned_until?: string;
}

interface VerifyResponse {
  access_token: string;
  refresh_token: string;
  user: GoTrueUser;
}

export interface VerifiedIdentity {
  id: string;
  email: string;
}

export class GoTrueClient {
  constructor(
    private readonly origin: string,
    private readonly serviceRoleKey: string,
  ) {}

  private async admin(path: string, init?: RequestInit): Promise<Response> {
    return fetch(`${this.origin}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${this.serviceRoleKey}`,
        "content-type": "application/json",
        ...init?.headers,
      },
      signal: AbortSignal.timeout(5_000),
    });
  }

  async ensureUser(email: string): Promise<GoTrueUser> {
    const list = await this.admin(
      `/admin/users?page=1&per_page=50&filter=${encodeURIComponent(email)}`,
    );
    if (!list.ok) throw new Error("Identity provider user lookup failed");
    const body = (await list.json()) as { users?: GoTrueUser[] };
    const found = body.users?.find((user) => user.email?.toLowerCase() === email);
    if (found) return found;

    const created = await this.admin("/admin/users", {
      method: "POST",
      body: JSON.stringify({ email, email_confirm: true, user_metadata: {} }),
    });
    if (!created.ok) throw new Error("Identity provider user creation failed");
    return (await created.json()) as GoTrueUser;
  }

  async generateEmailOtp(email: string): Promise<string> {
    const response = await this.admin("/admin/generate_link", {
      method: "POST",
      body: JSON.stringify({ type: "magiclink", email }),
    });
    if (!response.ok) throw new Error("Identity provider OTP generation failed");
    const body = (await response.json()) as { email_otp?: string };
    if (!body.email_otp || !/^\d{6}$/.test(body.email_otp)) {
      throw new Error("Identity provider returned an invalid OTP");
    }
    return body.email_otp;
  }

  async verifyEmailOtp(email: string, code: string): Promise<VerifiedIdentity> {
    const response = await fetch(`${this.origin}/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "email", email, token: code }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) throw new Error("OTP verification failed");
    const body = (await response.json()) as VerifyResponse;
    if (!body.access_token || !body.refresh_token || !body.user?.id || !body.user.email) {
      throw new Error("Identity provider returned an invalid verification response");
    }
    return { id: body.user.id, email: body.user.email.toLowerCase() };
  }
}
