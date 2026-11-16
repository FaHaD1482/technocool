// argon2id settings (OWASP 2024+: m=19 MiB, t=2, p=1). Kept in one place for the app and scripts.
// Algorithm 2 = argon2id in @node-rs/argon2.
export const ARGON2_OPTIONS = { algorithm: 2, memoryCost: 19456, timeCost: 2, parallelism: 1 } as const;
