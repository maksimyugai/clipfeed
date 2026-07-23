// Constant-time string comparison for the webhook secret header. A naive
// `===`/`!==` short-circuits at the first mismatched character, leaking
// timing information an attacker can use to brute-force the secret one
// byte at a time over many requests — this always walks the full length.
export function timingSafeEqualStrings(a: string, b: string): boolean {
  const aBytes = new TextEncoder().encode(a);
  const bBytes = new TextEncoder().encode(b);

  // Lengths aren't secret here (both are fixed-format strings), so an
  // early return on length mismatch doesn't leak anything meaningful about
  // the secret's content — only the byte-by-byte comparison below needs to
  // be constant-time.
  if (aBytes.length !== bBytes.length) {
    return false;
  }

  let diff = 0;
  for (let i = 0; i < aBytes.length; i++) {
    diff |= aBytes[i] ^ bBytes[i];
  }
  return diff === 0;
}
