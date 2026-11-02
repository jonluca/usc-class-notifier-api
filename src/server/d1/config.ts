export type DatabaseConfiguration = { provider: "postgres" } | { provider: "d1"; gatewayUrl: string; token: string };

export function getDatabaseConfiguration(
  environment: Readonly<Record<string, string | undefined>>,
): DatabaseConfiguration {
  const provider = environment.DATABASE_PROVIDER?.trim() || "postgres";
  if (provider === "postgres" || provider === "postgresql") {
    return { provider: "postgres" };
  }
  if (provider !== "d1") {
    throw new Error("DATABASE_PROVIDER must be postgres or d1");
  }
  let url: URL;
  try {
    url = new URL(environment.D1_GATEWAY_URL ?? "");
  } catch {
    throw new Error("D1_GATEWAY_URL must be an HTTPS origin");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error("D1_GATEWAY_URL must be an HTTPS origin without credentials, path, or query");
  }
  const token = environment.D1_GATEWAY_TOKEN;
  if (!token || token.length < 32 || token.length > 512 || /\s/.test(token)) {
    throw new Error("D1_GATEWAY_TOKEN must be a 32–512 character token without whitespace");
  }
  return { provider: "d1", gatewayUrl: url.origin, token };
}
