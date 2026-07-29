export const MAX_PUSH_ATTEMPTS = 3;

export type PushFailureClassification = "transient" | "permanent";

export type ParsedPushFailure = {
  classification: PushFailureClassification;
  attempt: number;
  maxAttempts: number;
  detail: string;
};

export type PushFailureDisposition = ParsedPushFailure & {
  retryable: boolean;
  error: string;
};

const PERMANENT_PATTERNS = [
  /authentication failed/i,
  /authentication unavailable/i,
  /permission (?:to .* )?denied/i,
  /permission denied \(publickey\)/i,
  /could not read username/i,
  /terminal prompts disabled/i,
  /repository not found/i,
  /does not appear to be a git repository/i,
  /requested url returned error: (?:401|403|404)\b/i,
  /non-fast-forward/i,
  /updates were rejected/i,
  /fetch first/i,
  /src refspec .* does not match any/i,
  /invalid refspec/i,
  /pre-receive hook declined/i,
  /protected branch hook declined/i,
  /deny updating a hidden ref/i,
  /\bGH0(?:06|13)\b/i,
];

const TRANSIENT_PATTERNS = [
  /could not resolve host/i,
  /could not resolve hostname/i,
  /temporary failure in name resolution/i,
  /failed to connect/i,
  /couldn't connect/i,
  /connection (?:timed out|reset|refused|closed)/i,
  /connection reset by peer/i,
  /connection closed by remote host/i,
  /no route to host/i,
  /network is unreachable/i,
  /operation timed out/i,
  /tls handshake timeout/i,
  /remote end hung up unexpectedly/i,
  /unexpected disconnect while reading sideband/i,
  /early eof/i,
  /curl (?:18|28|35|52|55|56|92)\b/i,
  /http\/2 stream .*internal_error/i,
  /requested url returned error: (?:408|429|5\d\d)\b/i,
  /\bhttp (?:408|429|5\d\d)\b/i,
  /\bE(?:CONNRESET|CONNREFUSED|HOSTUNREACH|NETUNREACH|TIMEDOUT)\b/i,
  /\bETIMEDOUT\b/i,
];

/** Unknown push failures are permanent: publishing is a fail-closed gate. */
export function classifyPushFailure(
  detail: string,
): PushFailureClassification {
  if (PERMANENT_PATTERNS.some((pattern) => pattern.test(detail))) {
    return "permanent";
  }
  if (TRANSIENT_PATTERNS.some((pattern) => pattern.test(detail))) {
    return "transient";
  }
  return "permanent";
}

export function parsePushFailure(error: string | null): ParsedPushFailure | null {
  if (!error) return null;

  const transient = error.match(
    /^git push failed \[transient (\d+)\/(\d+)\]: ([\s\S]*)$/i,
  );
  if (transient) {
    return {
      classification: "transient",
      attempt: Number(transient[1]),
      maxAttempts: Number(transient[2]),
      detail: transient[3] ?? "",
    };
  }

  const permanent = error.match(
    /^git push failed \[permanent\]: ([\s\S]*)$/i,
  );
  if (permanent) {
    return {
      classification: "permanent",
      attempt: 1,
      maxAttempts: 1,
      detail: permanent[1] ?? "",
    };
  }

  const legacy = error.match(/^git push failed: ([\s\S]*)$/i);
  if (!legacy) return null;
  const detail = legacy[1] ?? "";
  return {
    classification: classifyPushFailure(detail),
    attempt: 1,
    maxAttempts: MAX_PUSH_ATTEMPTS,
    detail,
  };
}

export function isRetryablePushFailure(error: string | null): boolean {
  const parsed = parsePushFailure(error);
  return Boolean(
    parsed?.classification === "transient" &&
      parsed.attempt < parsed.maxAttempts,
  );
}

export function recordPushFailure(
  detail: string,
  previousError: string | null,
): PushFailureDisposition {
  const classification = classifyPushFailure(detail);
  if (classification === "permanent") {
    return {
      classification,
      attempt: 1,
      maxAttempts: 1,
      detail,
      retryable: false,
      error: `git push failed [permanent]: ${detail}`,
    };
  }

  const previous = parsePushFailure(previousError);
  const previousAttempt =
    previous?.classification === "transient" ? previous.attempt : 0;
  const attempt = Math.min(previousAttempt + 1, MAX_PUSH_ATTEMPTS);
  return {
    classification,
    attempt,
    maxAttempts: MAX_PUSH_ATTEMPTS,
    detail,
    retryable: attempt < MAX_PUSH_ATTEMPTS,
    error:
      `git push failed [transient ${attempt}/${MAX_PUSH_ATTEMPTS}]: ` +
      detail,
  };
}
