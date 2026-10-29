import { SendLoginEmail } from "@/components/SendLoginEmail";
import Link from "next/link";

export default function Index() {
  return (
    <>
      <section className="w-full py-12 md:py-24 lg:py-32">
        <div className="container px-4 md:px-6">
          <div aria-roledescription="carousel" className="relative w-full max-w-6xl mx-auto" role="region">
            <div className="overflow-hidden">
              <div className="flex -ml-4">
                <div aria-roledescription="slide" className="min-w-0 shrink-0 grow-0 basis-full pl-4" role="group">
                  <div className="grid md:grid-cols-2 gap-8 items-center">
                    <div className="space-y-4">
                      <h2 className="text-3xl font-bold tracking-tighter sm:text-4xl md:text-5xl">
                        USC Schedule Helper
                      </h2>
                      <p className="text-gray-500 md:text-xl">Get notified when classes you want are available.</p>
                      <Link
                        href="/classes"
                        className="inline-flex min-h-11 items-center justify-center rounded-md bg-[#990000] px-8 py-2 text-sm font-semibold text-white hover:bg-red-900"
                      >
                        Find classes and add alerts
                      </Link>
                      <p className="text-sm text-gray-600">
                        Search and manage alerts here, or add them directly from USC with the browser extension.
                      </p>
                      <a
                        className="inline-flex h-10 items-center justify-center rounded-md bg-gray-900 px-8 text-sm font-medium text-gray-50 shadow-sm transition-colors hover:bg-gray-900/90 focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-gray-950 disabled:pointer-events-none disabled:opacity-50"
                        href="https://chrome.google.com/webstore/detail/usc-schedule-helper/gchplemiinhmilinflepfpmjhmbfnlhk"
                        target={"_blank"}
                      >
                        Get the browser extension
                      </a>
                      <SendLoginEmail />
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
        {/* Footer with /terms and /privacy links */}
        <footer className="mt-12 text-center text-sm text-gray-500 mx-auto">
          <a href="/terms" className="underline hover:text-gray-700">
            Terms of Service
          </a>
          {" | "}
          <a href="/privacy" className="underline hover:text-gray-700">
            Privacy Policy
          </a>
        </footer>
      </section>
    </>
  );
}
