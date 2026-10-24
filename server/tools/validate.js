export class ToolError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.code = code;
    this.extra = extra;
  }
}

export function str(input, key, { max = 300, required = false } = {}) {
  const v = input?.[key];
  if (v === undefined || v === null || v === '') {
    if (required) throw new ToolError('invalid_input', `"${key}" is required`);
    return undefined;
  }
  if (typeof v !== 'string') throw new ToolError('invalid_input', `"${key}" must be a string`);
  const t = v.trim();
  if (required && !t) throw new ToolError('invalid_input', `"${key}" is required`);
  return t.slice(0, max);
}

export function oneOf(input, key, allowed, { required = false, fallback } = {}) {
  const v = input?.[key];
  if (v === undefined || v === null || v === '') {
    if (required) throw new ToolError('invalid_input', `"${key}" is required (one of: ${allowed.join(', ')})`);
    return fallback;
  }
  if (!allowed.includes(v)) throw new ToolError('invalid_input', `"${key}" must be one of: ${allowed.join(', ')}`);
  return v;
}

export function int(input, key, { min = 0, max = 100, fallback } = {}) {
  const v = input?.[key];
  if (v === undefined || v === null || v === '') return fallback;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new ToolError('invalid_input', `"${key}" must be an integer between ${min} and ${max}`);
  return n;
}

export function bool(input, key, fallback = false) {
  const v = input?.[key];
  if (v === undefined || v === null) return fallback;
  return v === true || v === 'true';
}

export function withTimeout(promise, ms, code = 'timeout') {
  let t;
  const timeout = new Promise((_, reject) => {
    t = setTimeout(() => reject(new ToolError(code, `Timed out after ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
}
