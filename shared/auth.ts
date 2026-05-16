export const USERNAME_MIN_LENGTH = 1;
export const USERNAME_MAX_LENGTH = 16;
export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 64;

export function validateUsername(username: string): string | null {
  if (!username || username.length < USERNAME_MIN_LENGTH || username.length > USERNAME_MAX_LENGTH) {
    return `Username must be ${USERNAME_MIN_LENGTH}-${USERNAME_MAX_LENGTH} characters`;
  }
  if (!/^[a-zA-Z0-9_]+$/.test(username)) {
    return 'Username must be alphanumeric (underscores allowed)';
  }
  return null;
}

export function validatePassword(password: string): string | null {
  if (!password || password.length < PASSWORD_MIN_LENGTH || password.length > PASSWORD_MAX_LENGTH) {
    return `Password must be ${PASSWORD_MIN_LENGTH}-${PASSWORD_MAX_LENGTH} characters`;
  }
  return null;
}
