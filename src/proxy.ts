import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { isAuthenticated } from "@/server/auth";
import { isMaintenanceMode } from "@/server/maintenance";

export function proxy(req: NextRequest) {
  const path = req.nextUrl.pathname;
  // Include GETs: verification, watch links and refresh endpoints can mutate data.
  // The health endpoint performs only SELECT 1 and remains available to operators.
  if (isMaintenanceMode() && path !== "/api/health") {
    return new NextResponse("USC Schedule Helper is updating. Please try again shortly.", {
      status: 503,
      headers: { "Retry-After": "120", "Cache-Control": "no-store" },
    });
  }
  if ((path === "/admin" || path.startsWith("/admin/")) && !isAuthenticated(req)) {
    return new NextResponse("Authentication required", {
      status: 401,
      headers: { "WWW-Authenticate": "Basic" },
    });
  }

  return NextResponse.next();
}

export const config = {
  matcher: "/((?!_next/static|_next/image|favicon.ico).*)",
};
