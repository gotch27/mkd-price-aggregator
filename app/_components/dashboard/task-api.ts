export async function taskApi<T>(
  url: string,
  onUnauthorized: () => void,
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(url, { cache: "no-store", ...init });
  if (response.status === 401) {
    onUnauthorized();
    throw new Error("Sign in again to continue.");
  }
  const result = await response.json();
  if (!response.ok || !result.ok)
    throw new Error(result.errors?.[0]?.message ?? "Request failed");
  return result.data as T;
}
