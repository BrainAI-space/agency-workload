import { createConnection } from "node:net";

export interface OtpMessage {
  email: string;
  code: string;
  expiresMinutes: number;
  purpose: "invitation" | "sign-in";
}

export interface AuthMailer {
  sendOtp(message: OtpMessage): Promise<void>;
}

function safeHeader(value: string): string {
  if (!value || /[\r\n]/.test(value)) throw new Error("Unsafe mail header");
  return value;
}

export class FixedSmtpMailer implements AuthMailer {
  constructor(
    private readonly config: { host: string; port: number; from: string; senderName: string },
  ) {}

  async sendOtp(message: OtpMessage): Promise<void> {
    const email = safeHeader(message.email);
    const from = safeHeader(this.config.from);
    const sender = safeHeader(this.config.senderName);
    if (!/^\d{6}$/.test(message.code)) throw new Error("Invalid OTP");
    const subject =
      message.purpose === "invitation"
        ? "Your Agency Workload invitation code"
        : "Your Agency Workload sign-in code";
    const content = [
      `From: ${sender} <${from}>`,
      `To: ${email}`,
      `Subject: ${subject}`,
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=UTF-8",
      "",
      `Your one-time code is: ${message.code}`,
      "",
      `It expires in ${message.expiresMinutes} minutes.`,
      "If you did not request this code, ignore this message.",
    ].join("\r\n");
    await sendSmtp(this.config.host, this.config.port, from, email, content);
  }
}

async function sendSmtp(
  host: string,
  port: number,
  from: string,
  to: string,
  content: string,
): Promise<void> {
  const socket = createConnection({ host, port });
  socket.setEncoding("utf8");
  socket.setTimeout(5_000);
  let buffer = "";
  const pending: Array<(line: string) => void> = [];
  socket.on("data", (chunk) => {
    buffer += chunk;
    const lines = buffer.split("\r\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (/^\d{3} /.test(line)) pending.shift()?.(line);
    }
  });

  const response = () =>
    new Promise<string>((resolve, reject) => {
      pending.push(resolve);
      socket.once("error", reject);
      socket.once("timeout", () => reject(new Error("SMTP timeout")));
    });
  const command = async (value: string, expected: number) => {
    socket.write(`${value}\r\n`);
    const line = await response();
    if (Number(line.slice(0, 3)) !== expected) throw new Error("SMTP rejected fixed message");
  };

  try {
    const greeting = await response();
    if (!greeting.startsWith("220")) throw new Error("SMTP unavailable");
    await command("EHLO agency-workload.local", 250);
    await command(`MAIL FROM:<${from}>`, 250);
    await command(`RCPT TO:<${to}>`, 250);
    await command("DATA", 354);
    await command(`${content.replace(/^\./gm, "..")}\r\n.`, 250);
    socket.write("QUIT\r\n");
  } finally {
    socket.end();
  }
}
