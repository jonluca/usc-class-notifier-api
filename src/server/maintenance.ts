export function isMaintenanceMode(
  environment: { USC_MAINTENANCE_MODE?: string } = { USC_MAINTENANCE_MODE: process.env.USC_MAINTENANCE_MODE },
): boolean {
  return environment.USC_MAINTENANCE_MODE === "1" || environment.USC_MAINTENANCE_MODE === "true";
}
