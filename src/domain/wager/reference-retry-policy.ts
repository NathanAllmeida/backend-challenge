export class ReferenceRetryPolicy {
  static readonly MAX_ATTEMPTS = 10;
  static readonly BASE_DELAY_MS = 2_000;
  static readonly MAX_DELAY_MS = 5 * 60_000;

  static nextAttemptAt(attempts: number, now: Date): Date {
    const delay = Math.min(
      ReferenceRetryPolicy.BASE_DELAY_MS * 2 ** Math.max(attempts - 1, 0),
      ReferenceRetryPolicy.MAX_DELAY_MS,
    );

    return new Date(now.getTime() + delay);
  }

  static isExhausted(attempts: number): boolean {
    return attempts >= ReferenceRetryPolicy.MAX_ATTEMPTS;
  }
}
