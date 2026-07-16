export function assertExactAuthIntegrationBoundary(environment: NodeJS.ProcessEnv): void;

export interface PollForRecipientOtpOptions {
  deadlineMs?: number;
  fetchImpl?: typeof fetch;
  mailpitOrigin: string;
  now?: () => number;
  recipient: string;
  sleep?: (milliseconds: number) => Promise<void>;
}

export function pollForRecipientOtp(
  options: PollForRecipientOtpOptions,
): Promise<{ code: string; raw: string }>;
