import Link from "next/link";

export const Navbar = () => {
  return (
    <nav
      className={`h-16 max-h-16 bg-white drop-shadow-xs sticky top-0 z-50 px-4 rounded-b-2xl mx-auto max-w-7xl w-full flex shrink grow items-center overflow-hidden transition-all duration-300 ease-in-out justify-between`}
    >
      {/* Logo */}
      <Link href="/" className="rounded-lg px-1 py-1.5">
        USC Schedule Helper
      </Link>
      <Link href="/classes" className="rounded-lg px-1 py-1.5 text-sm sm:text-base">
        Find classes
      </Link>
      <Link href="/dashboard" className="rounded-lg px-1 py-1.5 text-sm sm:text-base">
        Dashboard
      </Link>
      <Link href="/faq" className="rounded-lg px-1 py-1.5">
        FAQ
      </Link>
    </nav>
  );
};
