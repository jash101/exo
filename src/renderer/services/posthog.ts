// PostHog analytics removed. All functions are no-ops — kept as stubs
// to avoid cascading import errors across the component tree.

type BreadcrumbLevel = "debug" | "info" | "warn" | "error";

interface PostHogConfig {
  enabled: boolean;
  apiKey: string;
  host: string;
  sessionReplay?: boolean;
}

export function addBreadcrumb(
  _level: BreadcrumbLevel,
  _message: string,
  _data?: Record<string, unknown>,
): void {
  // no-op
}

export function captureException(
  _error: Error | string,
  _extra?: Record<string, unknown>,
): void {
  // no-op
}

export function initPostHog(_config: PostHogConfig): void {
  // no-op
}

export function identifyUser(
  _email: string,
  _properties?: Record<string, string | number | boolean>,
): void {
  // no-op
}

export function trackEvent(
  _event: string,
  _properties?: Record<string, string | number | boolean | undefined>,
): void {
  // no-op
}

export function resetIdentity(): void {
  // no-op
}

export function shutdownPostHog(): void {
  // no-op
}

export function reconfigurePostHog(_config: PostHogConfig): void {
  // no-op
}

export function isPostHogActive(): boolean {
  return false;
}
