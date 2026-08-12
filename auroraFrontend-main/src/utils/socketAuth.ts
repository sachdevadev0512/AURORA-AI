const storageTokenKey = 'aurora_token';

export function getSocketAuthToken(): string | undefined {
  return localStorage.getItem(storageTokenKey) || undefined;
}

export function getSocketClientOptions() {
  const token = getSocketAuthToken();
  return {
    reconnection: true,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000,
    reconnectionAttempts: 10,
    auth: token ? { token } : {},
  };
}
