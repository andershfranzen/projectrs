export const USERNAME_MIN_LENGTH = 3;
export const USERNAME_MAX_LENGTH = 16;
export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 64;
export const DEVICE_ID_MAX_LENGTH = 64;

export function validateUsername(username: string): string | null {
  if (!username || username.length < USERNAME_MIN_LENGTH || username.length > USERNAME_MAX_LENGTH) {
    return `Username must be ${USERNAME_MIN_LENGTH}-${USERNAME_MAX_LENGTH} characters`;
  }
  if (!/^[a-zA-Z][a-zA-Z0-9_]*[a-zA-Z0-9]$/.test(username)) {
    return 'Username must start with a letter and contain only letters, numbers, or single underscores';
  }
  if (username.includes('__')) {
    return 'Username cannot contain consecutive underscores';
  }
  return null;
}

export function validatePassword(password: string): string | null {
  if (!password || password.length < PASSWORD_MIN_LENGTH || password.length > PASSWORD_MAX_LENGTH) {
    return `Password must be ${PASSWORD_MIN_LENGTH}-${PASSWORD_MAX_LENGTH} characters`;
  }
  return null;
}

export function validateDeviceId(deviceId: string): string | null {
  if (!deviceId || deviceId.length > DEVICE_ID_MAX_LENGTH) {
    return 'Missing or invalid device identifier';
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(deviceId)) {
    return 'Missing or invalid device identifier';
  }
  return null;
}
