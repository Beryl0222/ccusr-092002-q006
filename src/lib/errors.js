export function fail(status, message) {
  const error = new Error(message);
  error.status = status;
  throw error;
}
