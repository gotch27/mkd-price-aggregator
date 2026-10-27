export type LoginResult =
  | { status: "authenticated"; token: string }
  | { status: "invalid" }
  | { status: "limited"; retry_after_seconds: number };
